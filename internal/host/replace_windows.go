package host

import (
	"context"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// ReplaceFile atomically replaces a file, retrying if a Windows reader
// briefly holds it without FILE_SHARE_DELETE.
// Keep the old file intact if the handle remains open or the caller cancels.
func ReplaceFile(ctx context.Context, tmp, path string) error {
	deadline := time.Now().Add(time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := os.Rename(tmp, path)
		if (!errors.Is(err, windows.ERROR_SHARING_VIOLATION) && !errors.Is(err, windows.ERROR_ACCESS_DENIED)) || !time.Now().Before(deadline) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
