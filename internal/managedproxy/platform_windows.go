package managedproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/host"
	"golang.org/x/sys/windows"
)

type windowsCoreRecord struct {
	PID        uint32 `json:"pid"`
	Executable string `json:"executable"`
	Created    int64  `json:"created"`
}

func windowsCoreRecordPath(profile string) string {
	return filepath.Join(Dir(profile), "managed-process.json")
}

func coreEnvironment(dir string) []string {
	env := []string{"HOME=" + dir, "USERPROFILE=" + dir}
	for _, key := range []string{"SystemRoot", "WINDIR", "TEMP", "TMP"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func identifyCore(handle windows.Handle) (string, int64, error) {
	name := make([]uint16, 32768)
	size := uint32(len(name))
	if err := windows.QueryFullProcessImageName(handle, 0, &name[0], &size); err != nil {
		return "", 0, err
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return "", 0, err
	}
	return windows.UTF16ToString(name[:size]), created.Nanoseconds(), nil
}

// Stop opens one process handle and validates both its image and creation time
// before termination. A reused PID cannot terminate an unrelated application.
func stopWindowsCore(profile string) error {
	return stopRecordedWindowsCore(profile, "")
}

// Require a record belonging to both this profile and the installation being
// replaced. Other processes using the same binary remain untouched.
func ReleaseOrphanForUpdate(profile, installDir string) error {
	if !filepath.IsAbs(installDir) {
		return errors.New("未指定要更新的安装目录")
	}
	return stopRecordedWindowsCore(profile, filepath.Join(installDir, "resources", "mihomo.exe"))
}

func stopRecordedWindowsCore(profile, targetCore string) error {
	path := windowsCoreRecordPath(profile)
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		if targetCore != "" {
			return errors.New("此配置缺少代理进程记录，无法确认占用进程属于 Cage")
		}
		return nil
	}
	if err := host.CheckPrivateFile(path); err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var record windowsCoreRecord
	if len(b) > 4096 || json.Unmarshal(b, &record) != nil || record.PID == 0 || record.Created == 0 {
		return errors.New("Cage 代理进程记录无效")
	}
	core := targetCore
	if core == "" {
		core, err = CorePath()
		if err != nil {
			return err
		}
	}
	if !strings.EqualFold(filepath.Clean(core), filepath.Clean(record.Executable)) {
		return errors.New("Cage 代理进程不属于当前安装目录")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, record.PID)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		if targetCore != "" {
			return errors.New("记录的代理已退出，无法确认其余占用进程的归属")
		}
		return removeStaleCore(profile, path)
	}
	if targetCore == "" && errors.Is(err, windows.ERROR_ACCESS_DENIED) && !recordedCoreRunning(record) {
		// The core runs as the current user, so a PID that cannot be
		// terminated now belongs to another account's process.
		return removeStaleCore(profile, path)
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	image, created, err := identifyCore(handle)
	if err != nil {
		return err
	}
	if !sameCore(record, image, created) {
		if targetCore != "" {
			return errors.New("代理进程身份已变化，已保留当前进程")
		}
		// The recorded core exited and its PID was reused, typically after a
		// reboot. Forget the stale record and leave the other process alone.
		return removeStaleCore(profile, path)
	}
	if targetCore != "" && !usesWindowsProxyProfile(handle, profile) {
		return errors.New("代理未使用此配置目录，已保留当前进程")
	}
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return err
	}
	if code == 259 {
		if err := windows.TerminateProcess(handle, 0); err != nil {
			return err
		}
		state, err := windows.WaitForSingleObject(handle, 5000)
		if err != nil {
			return err
		}
		if state != windows.WAIT_OBJECT_0 {
			return errors.New("Cage 代理进程未能及时停止")
		}
	}
	return removeStaleCore(profile, path)
}

// Restoring a profile backup can duplicate a still-valid process record.
// Confirm the actual -d and -f arguments on the same pinned process.
func usesWindowsProxyProfile(handle windows.Handle, profile string) bool {
	// Windows command lines are limited to 32,767 UTF-16 code units. The
	// returned UNICODE_STRING and its string both reside in this buffer.
	buffer := make([]byte, 65536+unsafe.Sizeof(windows.NTUnicodeString{}))
	header := unsafe.Pointer(&buffer[0])
	var n uint32
	if windows.NtQueryInformationProcess(handle, windows.ProcessCommandLineInformation, header, uint32(len(buffer)), &n) != nil {
		return false
	}
	args, err := windows.DecomposeCommandLine((*windows.NTUnicodeString)(header).String())
	dir := Dir(profile)
	return err == nil && len(args) == 5 && args[1] == "-d" && strings.EqualFold(filepath.Clean(args[2]), dir) &&
		args[3] == "-f" && strings.EqualFold(filepath.Clean(args[4]), filepath.Join(dir, "config.yaml"))
}

func sameCore(record windowsCoreRecord, image string, created int64) bool {
	return strings.EqualFold(filepath.Clean(image), filepath.Clean(record.Executable)) && created == record.Created
}

func recordedCoreRunning(record windowsCoreRecord) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, record.PID)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	image, created, err := identifyCore(handle)
	return err == nil && sameCore(record, image, created)
}

func removeStaleCore(profile, path string) error {
	if err := removeWindowsCoreSocket(profile); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return &coreError{stage: "record.remove", err: err}
	}
	return nil
}

func removeWindowsCoreSocket(profile string) error {
	if err := os.Remove(Socket(profile)); err != nil && !os.IsNotExist(err) {
		return &coreError{stage: "socket.remove", err: err}
	}
	return nil
}

func startWindowsCoreProcess(profile string, cmd *exec.Cmd) error {
	if err := removeWindowsCoreSocket(profile); err != nil {
		return err
	}
	return cmd.Start()
}

func stopWindowsCoreAfterFailure(profile string, cause error) error {
	if err := stopWindowsCore(profile); err != nil {
		return errors.Join(cause, &coreError{stage: "startup.cleanup", err: err})
	}
	return cause
}

func startWindowsCore(ctx context.Context, profile string, s Store) error {
	name, err := PhysicalInterface(ctx)
	if err != nil {
		return err
	}
	path := filepath.Join(Dir(profile), "config.yaml")
	bound, _ := BoundInterface(path)
	if bound == name && Running(ctx, profile, s) {
		return nil
	}
	if err := Validate(ctx, profile, s); err != nil {
		return err
	}
	if err := stopWindowsCore(profile); err != nil {
		return err
	}
	l, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", s.Port))
	if err != nil {
		return errors.New("Cage 代理端口已被占用，请更换独立端口")
	}
	l.Close()
	core, err := CorePath()
	if err != nil {
		return err
	}
	if err := host.EnsurePrivateDir(filepath.Dir(Socket(profile))); err != nil {
		return err
	}
	b, err := s.Runtime(profile)
	if err != nil {
		return err
	}
	b, err = BindInterface(b, name)
	if err != nil {
		return err
	}
	if err := Write(path, b); err != nil {
		return err
	}
	log := diagnostics.New(profile).Stream("proxy", "warn")

	cmd := exec.Command(core, "-d", Dir(profile), "-f", path)
	cmd.Env, cmd.Stdout, cmd.Stderr = coreEnvironment(Dir(profile)), log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
	if err := startWindowsCoreProcess(profile, cmd); err != nil {
		_ = log.Close()
		return err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	image, created, err := identifyCore(handle)
	windows.CloseHandle(handle)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	record, _ := json.Marshal(windowsCoreRecord{PID: uint32(cmd.Process.Pid), Executable: image, Created: created})
	if err := Write(windowsCoreRecordPath(profile), record); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	go func() {
		err := cmd.Wait()
		_ = log.Close()
		if err != nil {
			_ = diagnostics.New(profile).Record("error", "proxy", "core exited: "+err.Error())
		}
	}()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	var lastReadiness error
	for {
		select {
		case <-ctx.Done():
			return stopWindowsCoreAfterFailure(profile, ctx.Err())
		case <-timeout.C:
			return stopWindowsCoreAfterFailure(profile, errors.Join(errors.New("代理核心启动超时，请查看私有代理日志"), lastReadiness))
		case <-ticker.C:
			lastReadiness = checkRunning(ctx, profile, s)
			if lastReadiness == nil {
				if err := host.ProtectFile(Socket(profile)); err != nil {
					return stopWindowsCoreAfterFailure(profile, &coreError{stage: "socket.protect", err: err})
				}
				return nil
			}
		}
	}
}
