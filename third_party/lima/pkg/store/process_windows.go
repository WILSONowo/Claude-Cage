// SPDX-FileCopyrightText: Copyright The Lima Authors
// SPDX-License-Identifier: Apache-2.0

package store

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// FAT-family file systems round write times down by up to two seconds, which
// would otherwise make a live owner look newer than its own PID file.
const pidFileTimeSlack = 2 * time.Second

// A process created after the PID file was written cannot be its owner. This
// also covers old PID files without a boot marker (Windows has no boot ID).
// Query failures retain the marker: they do not prove that its owner is gone.
func processStartedAfter(pid int, modified time.Time) (bool, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err == nil {
		defer windows.CloseHandle(handle)
		var created, exited, kernel, user windows.Filetime
		if windows.GetProcessTimes(handle, &created, &exited, &kernel, &user) == nil && created != (windows.Filetime{}) {
			return created.Nanoseconds() > modified.Add(pidFileTimeSlack).UnixNano(), nil
		}
	}
	// The snapshot includes processes whose handles we cannot open.
	created, ok := processCreationTimeFromSnapshot(pid)
	if !ok {
		return false, fmt.Errorf("cannot confirm creation time of Windows process %d", pid)
	}
	return created > modified.Add(pidFileTimeSlack).UnixNano(), nil
}

func processCreationTimeFromSnapshot(pid int) (int64, bool) {
	size := uint32(64 * 1024)
	for size <= 64<<20 {
		buf := make([]byte, size)
		var length uint32
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&buf[0]), size, &length)
		if err == windows.STATUS_INFO_LENGTH_MISMATCH {
			size = max(size*2, length)
			continue
		}
		if err != nil || length > uint32(len(buf)) {
			return 0, false
		}
		buf = buf[:length]
		for len(buf) >= int(unsafe.Sizeof(windows.SYSTEM_PROCESS_INFORMATION{})) {
			info := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&buf[0]))
			if info.UniqueProcessID == uintptr(pid) {
				if info.CreateTime <= 0 {
					return 0, false
				}
				created := windows.Filetime{LowDateTime: uint32(info.CreateTime), HighDateTime: uint32(info.CreateTime >> 32)}
				return created.Nanoseconds(), true
			}
			if uintptr(info.NextEntryOffset) < unsafe.Sizeof(*info) || info.NextEntryOffset > uint32(len(buf)) {
				break
			}
			buf = buf[info.NextEntryOffset:]
		}
		return 0, false
	}
	return 0, false
}
