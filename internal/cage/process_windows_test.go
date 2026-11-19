package cage

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestProcessSnapshotAgreesWithRecordedStart(t *testing.T) {
	current := processStartToken(os.Getpid())
	started, absent := snapshotProcess(os.Getpid())
	if current == "" || started != current || absent {
		t.Fatal("system snapshot and process handle disagree on creation time")
	}
	if started, absent := snapshotProcess(-1); started != "" || !absent {
		t.Fatal("nonexistent process was not identified as absent")
	}
}

func TestDeniedHandleForExitedVMOwner(t *testing.T) {
	const absentPID = 0x7fffffff
	if unopenedProcessMayBeRunning(absentPID, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("old VM owner absent from the process list is blocking restart")
	}
	if !unopenedProcessMayBeRunning(os.Getpid(), windows.ERROR_ACCESS_DENIED) {
		t.Fatal("access-denied live owner was treated as stopped")
	}
	if !unopenedProcessMayBeRunning(absentPID, windows.ERROR_INVALID_HANDLE) {
		t.Fatal("unexpected process query error was treated as proof of exit")
	}
}

func TestExitedOwnerWithDeniedProcessHandle(t *testing.T) {
	const marker = "CAGE_TEST_WAIT_FOR_VM_OWNER_EXIT"
	if os.Getenv(marker) == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestExitedOwnerWithDeniedProcessHandle$")
	cmd.Env = append(os.Environ(), marker+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		stdin.Close()
		if cmd.ProcessState == nil {
			_ = cmd.Wait()
		}
	}()
	pid := cmd.Process.Pid
	// Keep a handle to the kernel object even after the child exits. Opening
	// a new query handle will remain denied although the PID is now stale.
	handle, err := windows.OpenProcess(windows.WRITE_DAC, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	sd, err := windows.SecurityDescriptorFromString("D:(D;;0x1000;;;WD)(A;;GA;;;OW)")
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetKernelObjectSecurity(handle, windows.DACL_SECURITY_INFORMATION, sd); err != nil {
		t.Fatal(err)
	}
	checkDenied := func() {
		t.Helper()
		q, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err == nil {
			windows.CloseHandle(q)
			t.Skip("test host can bypass the fixture process DACL")
		}
		if err != windows.ERROR_ACCESS_DENIED {
			t.Fatalf("expected a denied query handle: %v", err)
		}
	}
	checkDenied()
	if !ProcessMayBeRunning(pid) {
		t.Fatal("live owner lost during access denial")
	}
	stdin.Close()
	if err = cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	checkDenied()
	if ProcessMayBeRunning(pid) {
		t.Fatal("stopped owner still blocks environment startup")
	}
}

func TestNewRunningOwnerReplacesInterruptedRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cage-running.json")
	if err := os.WriteFile(path, []byte(`{"pid":2147483647,"started":"123"}`), 0600); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	done := make(chan error, 1)
	go func() { done <- DefaultConfig().RecordRunningAt(dir) }()
	time.Sleep(75 * time.Millisecond)
	reader.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var record runningProfile
	if err != nil || json.Unmarshal(data, &record) != nil || record.PID != os.Getpid() || !record.alive() {
		t.Fatal("new hostagent failed to replace stale marker", err)
	}
}
