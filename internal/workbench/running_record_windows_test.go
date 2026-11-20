package workbench

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestVMRunningWhileOwnerMarkerIsTemporarilyLocked(t *testing.T) {
	s := testServer(t)
	s.preferences.Workspace = t.TempDir()
	dir := s.instanceDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = cfg.RecordRunningAt(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "cage-running.json")
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(ptr, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if !s.vmRunning() {
		t.Fatal("temporary sharing violation reported as a stopped environment")
	}
	if _, err := controllerVMOwners(s.profile); !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Fatalf("owner verification was not stopped by sharing violation: %v", err)
	}
}
