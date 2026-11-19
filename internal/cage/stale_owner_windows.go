package cage

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

// RetireStaleVMOwner repairs the specific readiness marker which makes an
// old Windows controller think an exited Linux guest is still online.
func RetireStaleVMOwner(profile string) (bool, error) {
	root, err := os.OpenRoot(storageAnchor(profile))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer root.Close()
	instance := filepath.Join("lima", InstanceName(profile, EnvironmentDir(profile)))
	name := filepath.Join(instance, "cage-running.json")
	previous, err := root.Open(name)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	identity, err := previous.Stat()
	if err != nil || !identity.Mode().IsRegular() || identity.Size() > 4096 {
		previous.Close()
		return false, err
	}
	stale := confirmedExitedRecord(previous)
	previous.Close()
	if !stale {
		return false, nil
	}

	// All Lima commands share this lease. Decline concurrent launches, live
	// hostagents and migrations. Never run storage recovery during repair.
	lock, err := os.OpenFile(filepath.Join(profile, "environment-storage.lock"), os.O_RDWR, 0)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	if acquired, err := lockStorageFile(lock, true); err != nil || !acquired {
		return false, err
	}
	if _, err := os.Stat(filepath.Join(profile, pendingFile)); !os.IsNotExist(err) {
		return false, err
	}
	if _, err := getStorageLocation(profile); err != nil {
		return false, err
	}
	pinned, err := root.Stat(".")
	if err != nil {
		return false, err
	}
	current, err := os.Stat(storageAnchor(profile))
	if err != nil || !os.SameFile(current, pinned) {
		return false, err
	}
	for _, dir := range []string{"lima", instance} {
		info, err := root.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false, err
		}
	}
	for _, pidFile := range []string{"ha.pid", "qemu.pid"} {
		if _, err := root.Lstat(filepath.Join(instance, pidFile)); !os.IsNotExist(err) {
			return false, err
		}
	}
	path := filepath.Join(root.Name(), name)
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.DELETE, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !os.SameFile(identity, info) {
		return false, err
	}
	var details windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &details); err != nil {
		return false, err
	}
	if details.NumberOfLinks != 1 || details.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 ||
		!confirmedExitedRecord(f) {
		return false, nil
	}
	allowed, err := userMayDeleteMarker(h)
	if err != nil || !allowed {
		return false, err
	}
	discard := byte(1)
	if err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &discard, 1); err != nil {
		return false, err
	}
	return true, nil
}

func confirmedExitedRecord(f *os.File) bool {
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	var r runningProfile
	if err != nil || len(data) > 4096 || json.Unmarshal(data, &r) != nil || r.PID <= 0 || uint64(r.PID) > 1<<32-1 {
		return false
	}
	stamp, err := strconv.ParseInt(r.Started, 10, 64)
	if err != nil || stamp <= 0 {
		return false
	}
	digest, err := hex.DecodeString(r.Fingerprint)
	if err != nil || len(digest) != 32 {
		return false
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(r.PID))
	if err == nil {
		defer windows.CloseHandle(h)
		state, err := windows.WaitForSingleObject(h, 0)
		if err != nil || state != windows.WAIT_OBJECT_0 {
			return false
		}
	} else if err != windows.ERROR_ACCESS_DENIED && err != windows.ERROR_INVALID_PARAMETER {
		return false
	}
	_, absent := snapshotProcess(r.PID)
	return absent
}

// An elevated updater must only retire metadata which the current user is
// explicitly allowed to delete. Check the DACL on the very same pinned file.
func userMayDeleteMarker(h windows.Handle) (bool, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false, err
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return false, err
	}
	allowed := false
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			return false, err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return false, nil
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid.Equals(user.User.Sid) && ace.Mask&windows.DELETE != 0 && ace.Header.AceFlags&windows.INHERIT_ONLY_ACE == 0 {
			allowed = true
		}
	}
	return allowed, nil
}
