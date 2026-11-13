//go:build !windows

package remotehost

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
)

func dialAgent(ctx context.Context, path string) (net.Conn, error) {
	if path == "" {
		path = os.Getenv("SSH_AUTH_SOCK")
	}
	if path == "" {
		return nil, errors.New("SSH agent unavailable")
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}

func validAgentSocket(path string) bool { return filepath.IsAbs(path) }
