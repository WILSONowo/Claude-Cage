package workbench

import (
	"path/filepath"
	"runtime"

	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/hostimage"
)

func linuxGuestSystems(platform, arch string) []string {
	if platform == "darwin" && arch == "arm64" || (platform == "windows" || platform == "linux") && arch == "amd64" {
		return []string{guestos.Ubuntu2204}
	}
	return nil
}

func (s *Server) installedLinuxSystem() (string, error) {
	return hostimage.LinuxSystem(filepath.Join(s.profile, "state"))
}

func canInstallCatalogLinux(system string) bool {
	for _, candidate := range linuxGuestSystems(runtime.GOOS, runtime.GOARCH) {
		if system == candidate {
			return true
		}
	}
	return false
}
