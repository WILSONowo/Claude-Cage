//go:build !windows

package cachelock

import (
	"context"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func WithDirectory(ctx context.Context, dir string, fn func() error) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return withLock(ctx, file, fn)
}

// WithFile holds an exclusive lock on a stable file for the duration of fn.
func WithFile(ctx context.Context, path string, fn func() error) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	return withLock(ctx, file, fn)
}

func withLock(ctx context.Context, file *os.File, fn func() error) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
			return fn()
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EINTR) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
