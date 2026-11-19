//go:build !windows

package vm

import (
	"context"
	"os"
)

func replaceLimaConfig(_ context.Context, tmp, path string) error {
	return os.Rename(tmp, path)
}
