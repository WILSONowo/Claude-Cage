package vm

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lima-vm/lima/v2/pkg/limatype/filenames"
	"github.com/lima-vm/lima/v2/pkg/store"
	"golang.org/x/sys/windows"
)

func TestGuestPowerdownRequiresMatchingQMPNameAndAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name, guest string
		refuse      bool
		want        []string
		wantErr     bool
	}{
		{"normal", "lima-local", false, []string{"qmp_capabilities", "query-name", "system_powerdown"}, false},
		{"wrong guest", "lima-other", false, []string{"qmp_capabilities", "query-name"}, true},
		{"cannot power off", "lima-local", true, []string{"qmp_capabilities", "query-name", "system_powerdown"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "qmp")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(dir)
			listener, err := net.Listen("unix", filepath.Join(dir, filenames.QMPSock))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			seen := make(chan []string, 1)
			go func() {
				var commands []string
				defer func() { seen <- commands }()
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				enc, dec := json.NewEncoder(conn), json.NewDecoder(conn)
				_ = enc.Encode(map[string]any{"QMP": map[string]any{}})
				for {
					var cmd struct {
						Execute string
						ID      int
					}
					if err := dec.Decode(&cmd); err != nil {
						return
					}
					commands = append(commands, cmd.Execute)
					reply := map[string]any{"id": cmd.ID, "return": map[string]any{}}
					switch cmd.Execute {
					case "query-name":
						reply["return"] = map[string]string{"name": tc.guest}
					case "system_powerdown":
						if tc.refuse {
							delete(reply, "return")
							reply["error"] = map[string]string{"class": "GenericError"}
						}
					}
					_ = enc.Encode(map[string]string{"event": "RESUME"})
					_ = enc.Encode(reply)
				}
			}()
			err = requestQEMUPowerdown(context.Background(), dir, "local")
			if (err != nil) != tc.wantErr {
				t.Fatalf("powerdown: %v", err)
			}
			if commands := <-seen; !reflect.DeepEqual(commands, tc.want) {
				t.Fatalf("sent %v, want %v", commands, tc.want)
			}
		})
	}
}
func TestStoppedUpdateRefusesUnverifiedPID(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "qemu.pid"), []byte("not-a-pid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := UpdateQEMUPID(dir); err == nil {
		t.Fatal("accepted invalid PID file")
	}
	if err := os.WriteFile(filepath.Join(dir, "qemu.pid"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	if pid, err := UpdateQEMUPID(dir); err != nil || pid != 0 {
		t.Fatalf("stale record for a different executable: pid=%d err=%v", pid, err)
	}
}

func TestLimaIgnoresExitedWindowsHostagentWithRetainedProcessHandle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, filenames.HostAgentPID)
	cmd := exec.Command("cmd.exe", "/d", "/q")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		input.Close()
		if cmd.ProcessState == nil {
			cmd.Wait()
		}
	}()
	pid := cmd.Process.Pid
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	// Legacy installations have PID files without a boot marker.
	if err := os.WriteFile(path, []byte(strconv.Itoa(pid)), 0644); err != nil {
		t.Fatal(err)
	}
	if got, err := store.ReadPIDFile(path); got != pid || err != nil {
		t.Fatalf("running: %d %v", got, err)
	}
	input.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if got, err := store.ReadPIDFile(path); got != 0 || err != nil {
		t.Fatalf("exited: %d %v", got, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stale hostagent pidfile: %v", err)
	}
}

func TestWindowsBootMarkerIgnoresReusedLivePIDFromPreviousBoot(t *testing.T) {
	dir := t.TempDir()
	pidfile := filepath.Join(dir, filenames.HostAgentPID)
	if err := store.WritePIDFile(pidfile, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, filenames.BootSession)
	actual, err := os.ReadFile(marker)
	if err != nil || strings.TrimSpace(string(actual)) == "" {
		t.Fatal("no Windows boot marker", err)
	}
	if err := os.WriteFile(marker, []byte("prior-boot"), 0644); err != nil {
		t.Fatal(err)
	}
	if got, err := store.ReadPIDFile(pidfile); got != 0 || err != nil {
		t.Fatalf("trusted a prior boot PID: %d %v", got, err)
	}
	if err := store.WritePIDFile(pidfile, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if updated, err := os.ReadFile(marker); err != nil || string(actual) != string(updated) {
		t.Fatal("boot ID not stable", err)
	}
}
