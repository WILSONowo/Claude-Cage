// SPDX-FileCopyrightText: Copyright The Lima Authors
// SPDX-License-Identifier: Apache-2.0

package osutil

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The boot session UUID identifies one boot even if a process ID is reused.
func BootSessionID() (string, error) {
	var info struct {
		ID           windows.GUID
		FirmwareType uint32
		_            uint32
		BootFlags    uint64
	}
	var size uint32
	if err := windows.NtQuerySystemInformation(windows.SystemBootEnvironmentInformation, unsafe.Pointer(&info), uint32(unsafe.Sizeof(info)), &size); err != nil {
		return "", err
	}
	if size < uint32(unsafe.Sizeof(info.ID)) || info.ID == (windows.GUID{}) {
		return "", errors.New("invalid Windows boot identifier")
	}
	return info.ID.String(), nil
}
