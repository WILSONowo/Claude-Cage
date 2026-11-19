package cage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sylvinus/agent-vm/internal/host"
)

func TestRetireStaleVMOwner(t *testing.T) {
	for _, mode := range []string{"exited", "owner-alive", "ha.pid", "qemu.pid", "shared-lock", "open-record", "hardlink", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			profile := t.TempDir()
			instance := filepath.Join(profile, "state", "lima", InstanceName(profile, EnvironmentDir(profile)))
			if err := host.EnsurePrivateDir(instance); err != nil {
				t.Fatal(err)
			}
			lock, err := openStorageLock(profile, false)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "shared-lock" {
				defer lock.Close()
			} else {
				lock.Close()
			}
			record := runningProfile{PID: 0x7fffffff, Started: "123", Fingerprint: strings.Repeat("a", 64)}
			if mode == "owner-alive" {
				record.PID = os.Getpid()
			}
			if mode == "legacy" {
				record.Started = ""
			}
			path := filepath.Join(instance, "cage-running.json")
			body, _ := json.Marshal(record)
			if err := os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
			if err := host.ProtectFile(path); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "ha.pid", "qemu.pid":
				if err := os.WriteFile(filepath.Join(instance, mode), []byte(fmt.Sprint(os.Getpid())), 0600); err != nil {
					t.Fatal(err)
				}
			case "open-record":
				f, err := os.Open(path)
				if err != nil {
					t.Fatal(err)
				}
				defer f.Close()
			case "hardlink":
				if err := os.Link(path, filepath.Join(instance, "other.json")); err != nil {
					t.Fatal(err)
				}
			}
			cleared, err := RetireStaleVMOwner(profile)
			if err != nil || cleared != (mode == "exited") {
				t.Fatalf("cleared=%v, err=%v", cleared, err)
			}
			data, err := os.ReadFile(path)
			if cleared && !os.IsNotExist(err) || !cleared && (err != nil || string(data) != string(body)) {
				t.Fatalf("unexpected record after cleanup: %v", err)
			}
		})
	}
}
