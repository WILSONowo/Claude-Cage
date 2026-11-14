package cage

import (
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

func profileProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err == windows.ERROR_ACCESS_DENIED
	}
	defer windows.CloseHandle(h)
	var code uint32
	return windows.GetExitCodeProcess(h, &code) == nil && code == 259
}

func processStartToken(pid int) string {
	if pid <= 0 {
		return ""
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err == windows.ERROR_ACCESS_DENIED {
		return snapshotStartToken(pid)
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

// A limited process handle can be denied after a PID has been reused.
// Compare the system snapshot creation time, without treating access denied
// as proof that the recorded owner has exited.
func snapshotStartToken(pid int) string {
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
			return ""
		}
		for offset := uint32(0); uint64(offset)+uint64(unsafe.Sizeof(windows.SYSTEM_PROCESS_INFORMATION{})) <= uint64(used); {
			entry := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&data[offset]))
			if entry.UniqueProcessID == uintptr(pid) && entry.CreateTime > 0 {
				tick := uint64(entry.CreateTime)
				stamp := windows.Filetime{HighDateTime: uint32(tick >> 32), LowDateTime: uint32(tick)}
				return strconv.FormatInt(stamp.Nanoseconds(), 10)
			}
			if entry.NextEntryOffset == 0 || entry.NextEntryOffset > used-offset {
				break
			}
			offset += entry.NextEntryOffset
		}
		return ""
	}
	return ""
}
