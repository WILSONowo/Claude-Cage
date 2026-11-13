package managedproxy

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoveStaleCoreRetainsRecordOnSocketFailure(t *testing.T) {
	profile := t.TempDir()
	socket := Socket(profile)
	if err := os.MkdirAll(socket, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(socket)) })
	if err := os.WriteFile(filepath.Join(socket, "owned-child"), []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	record := windowsCoreRecordPath(profile)
	if err := Write(record, []byte("keep ownership evidence")); err != nil {
		t.Fatal(err)
	}
	err := removeStaleCore(profile, record)
	var pathError *os.PathError
	if !errors.As(err, &pathError) {
		t.Errorf("socket removal failure was lost: %v", err)
	}
	if err != nil && strings.Contains(err.Error(), socket) {
		t.Error("socket path leaked in cleanup error")
	}
	if b, err := os.ReadFile(record); err != nil || string(b) != "keep ownership evidence" {
		t.Errorf("cleanup failure discarded the process record: %v", err)
	}
	cmd := exec.Command("unused-core")
	cmd.Err = errors.New("command start reached")
	err = startWindowsCoreProcess(profile, cmd)
	var failure *coreError
	if !errors.As(err, &failure) || failure.stage != "socket.remove" || cmd.Process != nil || errors.Is(err, cmd.Err) {
		t.Fatalf("socket failure did not prevent core launch: %v", err)
	}
}

func TestRemoveWindowsCoreSocket(t *testing.T) {
	profile := t.TempDir()
	socket := Socket(profile)
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(socket)) })
	if err := os.WriteFile(socket, []byte("owned stale socket"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeWindowsCoreSocket(profile); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socket); !os.IsNotExist(err) {
		t.Fatalf("socket was not removed: %v", err)
	}
	if err := removeWindowsCoreSocket(profile); err != nil {
		t.Fatalf("missing socket was not accepted: %v", err)
	}
}

func TestWindowsStartupFailureRetainsCleanupError(t *testing.T) {
	profile := t.TempDir()
	if err := Write(windowsCoreRecordPath(profile), []byte("invalid record")); err != nil {
		t.Fatal(err)
	}
	err := stopWindowsCoreAfterFailure(profile, context.Canceled)
	var cleanup *coreError
	if !errors.Is(err, context.Canceled) || !errors.As(err, &cleanup) || cleanup.stage != "startup.cleanup" || cleanup.Unwrap() == nil {
		t.Fatalf("startup or cleanup cause was lost: %v", err)
	}
	if strings.Contains(err.Error(), profile) {
		t.Fatalf("cleanup exposed a private path: %v", err)
	}
	if _, err := os.Stat(windowsCoreRecordPath(profile)); err != nil {
		t.Fatalf("failed cleanup discarded its record: %v", err)
	}
}

// A PID reused after a reboot must neither be terminated nor block startup.
func TestStopWindowsCoreForgetsReusedPID(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	core := filepath.Join(filepath.Dir(exe), "mihomo.exe")
	if err := os.WriteFile(core, []byte("placeholder"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(core) })
	for name, pid := range map[string]uint32{"same user": uint32(os.Getpid()), "system": 4, "exited": ^uint32(0)} {
		t.Run(name, func(t *testing.T) {
			profile := t.TempDir()
			b, _ := json.Marshal(windowsCoreRecord{PID: pid, Executable: core, Created: 1})
			if err := Write(windowsCoreRecordPath(profile), b); err != nil {
				t.Fatal(err)
			}
			if err := stopWindowsCore(profile); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Lstat(windowsCoreRecordPath(profile)); !os.IsNotExist(err) {
				t.Fatal("stale core record was kept")
			}
			// A stale identity is still useful evidence when its socket cannot
			// be removed. In particular, a missing PID must not lose it first.
			socket := Socket(profile)
			if err := os.MkdirAll(socket, 0700); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(socket)) })
			if err := os.WriteFile(filepath.Join(socket, "owned-child"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			if err := Write(windowsCoreRecordPath(profile), b); err != nil {
				t.Fatal(err)
			}
			var failure *coreError
			if err := stopWindowsCore(profile); !errors.As(err, &failure) || failure.stage != "socket.remove" {
				t.Fatalf("socket cleanup failure was lost: %v", err)
			}
			if kept, err := os.ReadFile(windowsCoreRecordPath(profile)); err != nil || string(kept) != string(b) {
				t.Fatalf("failed socket cleanup discarded identity evidence: %v", err)
			}
		})
	}
}
