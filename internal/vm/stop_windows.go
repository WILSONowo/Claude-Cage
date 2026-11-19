package vm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lima-vm/lima/v2/pkg/limatype"
	"github.com/lima-vm/lima/v2/pkg/limatype/filenames"
	"github.com/lima-vm/lima/v2/pkg/store"
	"golang.org/x/sys/windows"
)

// Let the guest power off first. The hostagent observes its driver exiting
// and releases its own resources. Signalling the hostagent first would let an
// older Lima force-kill QEMU on a QMP error or ACPI timeout.
func stopInstance(ctx context.Context, inst *limatype.Instance) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute+10*time.Second)
	defer cancel()
	if err := powerDownQEMU(ctx, inst.Dir, inst.Name, inst.DriverPID); err != nil {
		return err
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		current, err := store.Inspect(ctx, inst.Name)
		if err != nil {
			return err
		}
		if current.Status == limatype.StatusStopped {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("环境已关闭，等待后台退出超时: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func stopOrphanedInstance(ctx context.Context, inst *limatype.Instance) error {
	if inst.VMType != limatype.QEMU {
		return errors.New("unsupported orphaned VM driver")
	}
	return powerDownQEMU(ctx, inst.Dir, inst.Name, inst.DriverPID)
}

// UpdateQEMUPID verifies a pidfile in case the VM crashed and Windows reused its PID.
func UpdateQEMUPID(dir string) (int, error) {
	b, err := os.ReadFile(filepath.Join(dir, "qemu.pid"))
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0, errors.New("无法识别环境的 QEMU 进程")
	}
	handle, err := openInstanceQEMU(dir, filepath.Base(dir), pid)
	if err != nil || handle == 0 {
		return 0, err
	}
	windows.CloseHandle(handle)
	return pid, nil
}

func openInstanceQEMU(dir, name string, pid int) (windows.Handle, error) {
	if pid <= 0 {
		return 0, errors.New("无法确认环境的 QEMU 进程")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil || state == windows.WAIT_OBJECT_0 {
		windows.CloseHandle(handle)
		return 0, err
	}
	image := make([]uint16, 32768)
	size := uint32(len(image))
	if err := windows.QueryFullProcessImageName(handle, 0, &image[0], &size); err != nil {
		windows.CloseHandle(handle)
		return 0, err
	}
	if !strings.EqualFold(filepath.Base(windows.UTF16ToString(image[:size])), "qemu-system-x86_64.exe") {
		windows.CloseHandle(handle)
		return 0, nil
	}
	if !isQEMU(pid, dir, name) {
		windows.CloseHandle(handle)
		return 0, errors.New("环境进程身份已变化，未发送关机请求")
	}
	return handle, nil
}

// StopQEMUForUpdate requests ACPI shutdown before asking a retiring (possibly
// older) controller to release its resources. Validate the instance a second
// time and keep the same process handle through shutdown.
func StopQEMUForUpdate(ctx context.Context, dir string, pid int) error {
	return powerDownQEMU(ctx, dir, filepath.Base(dir), pid)
}

func powerDownQEMU(ctx context.Context, dir, name string, pid int) error {
	handle, err := openInstanceQEMU(dir, name, pid)
	if err != nil || handle == 0 {
		return err
	}
	defer windows.CloseHandle(handle)
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if err := requestQEMUPowerdown(ctx, dir, name); err != nil {
		return fmt.Errorf("无法请求环境正常关机: %w", err)
	}
	for ctx.Err() == nil {
		state, err := windows.WaitForSingleObject(handle, 250)
		if err != nil {
			return err
		}
		if state == windows.WAIT_OBJECT_0 {
			var code uint32
			if err := windows.GetExitCodeProcess(handle, &code); err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("QEMU 意外退出（%d），请检查环境状态", code)
			}
			return nil
		}
	}
	return fmt.Errorf("环境尚未完成关机: %w", ctx.Err())
}

func requestQEMUPowerdown(ctx context.Context, dir, name string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(dir, filenames.QMPSock))
	if err != nil {
		return err
	}
	defer conn.Close()
	closeOnCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer closeOnCancel()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	dec := json.NewDecoder(io.LimitReader(conn, 64<<10))
	var greeting struct{ QMP json.RawMessage }
	if err := dec.Decode(&greeting); err != nil {
		return err
	}
	if len(greeting.QMP) == 0 {
		return errors.New("invalid QMP greeting")
	}
	enc := json.NewEncoder(conn)
	for i, command := range []string{"qmp_capabilities", "query-name", "system_powerdown"} {
		if err := enc.Encode(map[string]any{"execute": command, "id": i + 1}); err != nil {
			return err
		}
		for {
			var reply struct {
				ID     int
				Return json.RawMessage
			}
			if err := dec.Decode(&reply); err != nil {
				return err
			}
			if reply.ID != i+1 {
				continue
			} // asynchronous QMP event
			if len(reply.Return) == 0 {
				return fmt.Errorf("QMP refused %s", command)
			}
			if command == "query-name" {
				var guest struct{ Name string }
				if err := json.Unmarshal(reply.Return, &guest); err != nil || guest.Name != "lima-"+name {
					return errors.New("QMP returned a different environment name")
				}
			}
			break
		}
	}
	return nil
}
