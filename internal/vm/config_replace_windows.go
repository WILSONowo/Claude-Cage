package vm

import (
	"context"

	"github.com/sylvinus/agent-vm/internal/host"
)

func replaceLimaConfig(ctx context.Context, tmp, path string) error {
	return host.ReplaceFile(ctx, tmp, path)
}
