package vm

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/lima-vm/lima/v2/pkg/limatype/filenames"
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
