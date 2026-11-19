package cage

import (
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ProcessMayBeRunning is conservative if neither a handle nor the system
// process list can establish that the owner has exited.
func ProcessMayBeRunning(pid int) bool {
	if pid <= 0 || uint64(pid) > 1<<32-1 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return unopenedProcessMayBeRunning(pid, err)
	}
	defer windows.CloseHandle(h)
	var code uint32
	return windows.GetExitCodeProcess(h, &code) != nil || code == 259
}

func unopenedProcessMayBeRunning(pid int, err error) bool {
	if err == windows.ERROR_ACCESS_DENIED {
		_, absent := snapshotProcess(pid)
		return !absent
	}
	return err != windows.ERROR_INVALID_PARAMETER
}

func processStartToken(pid int) string {
	if pid <= 0 {
		return ""
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err == windows.ERROR_ACCESS_DENIED {
		started, _ := snapshotProcess(pid)
		return started
	}
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil {
		return ""
	}
	return strconv.FormatInt(created.Nanoseconds(), 10)
}

// Windows can deny OpenProcess even for an exited VM owner. Only report
// absence after reading a complete snapshot through its terminal record.
func snapshotProcess(pid int) (started string, absent bool) {
	for size := uint32(256 << 10); size <= 64<<20; {
		data := make([]byte, size)
		var used uint32
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&data[0]), size, &used)
		if err == windows.STATUS_INFO_LENGTH_MISMATCH {
			if used > size {
				size = used
			} else {
				size *= 2
			}
			continue
		}
		if err != nil || used > size {
			return "", false
		}
		for offset := uint32(0); uint64(offset)+uint64(unsafe.Sizeof(windows.SYSTEM_PROCESS_INFORMATION{})) <= uint64(used); {
			entry := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&data[offset]))
			if entry.UniqueProcessID == uintptr(pid) {
				if entry.CreateTime <= 0 {
					return "", false
				}
				tick := uint64(entry.CreateTime)
				stamp := windows.Filetime{HighDateTime: uint32(tick >> 32), LowDateTime: uint32(tick)}
				return strconv.FormatInt(stamp.Nanoseconds(), 10), false
			}
			if entry.NextEntryOffset == 0 {
				return "", true
			}
			if uintptr(entry.NextEntryOffset) < unsafe.Sizeof(*entry) || entry.NextEntryOffset > used-offset {
				return "", false
			}
			offset += entry.NextEntryOffset
		}
		return "", false
	}
	return "", false
}
