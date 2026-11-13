//go:build windows

package remotehost

import (
	"context"
	"github.com/Microsoft/go-winio"
	"net"
	"os"
	"path/filepath"
	"strings"
)

func dialAgent(ctx context.Context, path string) (net.Conn, error) {
	if path == "" {
		path = os.Getenv("SSH_AUTH_SOCK")
	}
	if path == "" {
		path = `\\.\pipe\openssh-ssh-agent`
	}
	path = filepath.FromSlash(path)
	if strings.HasPrefix(strings.ToLower(path), `\\.\pipe\`) {
		return winio.DialPipeContext(ctx, path)
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}

func validAgentSocket(path string) bool {
	path = filepath.FromSlash(path)
	if strings.HasPrefix(strings.ToLower(path), `\\.\pipe\`) {
		name := path[len(`\\.\pipe\`):]
		return name != "" && !strings.ContainsAny(name, `\:`) && name != "." && name != ".."
	}
	return filepath.IsAbs(path) && len(filepath.VolumeName(path)) == 2 && !strings.Contains(path[2:], ":")
}
