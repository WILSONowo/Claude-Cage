//go:build !windows

package cage

import (
	"errors"
	"syscall"
)

func ProcessMayBeRunning(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
