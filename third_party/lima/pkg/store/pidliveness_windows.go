// SPDX-FileCopyrightText: Copyright The Lima Authors
// SPDX-License-Identifier: Apache-2.0

package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows can still open an exited process when another handle pins its PID.
func windowsPIDAlive(pid int) (bool, error) {
	if pid < 1 || uint64(pid) > 1<<32-1 {
		return false, fmt.Errorf("invalid VM process ID: %d", pid)
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// A protected process can deny a new handle even after exit. If its
		// PID is still in the process list keep the instance busy.
		snapshot, snapErr := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
		if snapErr != nil {
			return false, snapErr
		}
		defer windows.CloseHandle(snapshot)
		entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
		for snapErr = windows.Process32First(snapshot, &entry); snapErr == nil; snapErr = windows.Process32Next(snapshot, &entry) {
			if entry.ProcessID == uint32(pid) {
				return true, nil
			}
		}
		if errors.Is(snapErr, windows.ERROR_NO_MORE_FILES) {
			return false, nil
		}
		return false, snapErr
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(h)
	state, err := windows.WaitForSingleObject(h, 0)
	return state != windows.WAIT_OBJECT_0, err
}

func readCurrentPID(path string, pid int) (int, error) {
	alive, err := windowsPIDAlive(pid)
	if err != nil {
		return 0, err
	}
	if alive {
		return pid, nil
	}
	// Remove only the same still-stale record. A concurrent launcher may
	// replace it between our initial read and this exclusive open.
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.DELETE, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return 0, fmt.Errorf("cannot verify VM PID file %s", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, 32))
	if err != nil {
		return 0, err
	}
	current, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0, err
	}
	if current != pid {
		return 0, fmt.Errorf("VM PID changed while checking %s; retry", path)
	}
	if alive, err := windowsPIDAlive(pid); err != nil || alive {
		return pid, err
	}
	remove := byte(1)
	if err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &remove, uint32(unsafe.Sizeof(remove))); err != nil {
		return 0, err
	}
	return 0, nil
}
