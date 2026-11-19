//go:build !windows

package host

import (
	"context"
	"os"
)

// ReplaceFile atomically replaces a file.
func ReplaceFile(_ context.Context, tmp, path string) error {
	return os.Rename(tmp, path)
}
