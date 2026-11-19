package guestos

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"

	"os/exec"
	"path/filepath"

	"github.com/sylvinus/agent-vm/internal/cage"
)

func WindowsInstallCommand(ctx context.Context, profile, kit string, install Installation) (*exec.Cmd, error) {
	state, err := cage.StoragePhysicalPath(filepath.Join(profile, "state"))
	if err != nil {
		return nil, err
	}
	manifest, err := RequiredNativeComponents(kit, Windows11)
	if err != nil {
		return nil, err
	}
	manifestPath := filepath.Join(profile, "windows-components-required.json")
	if err = WriteNativeComponentManifest(manifestPath, manifest); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	return systemPowerShell(ctx, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", filepath.Join(kit, "setup-windows-guest.ps1"), "-Profile", profile, "-State", state, "-InstallationID", install.ID.String(), "-IsoPath", install.Media, "-ExpectedIsoSha256", install.SHA256, "-ManifestPath", manifestPath, "-ManifestSHA256", digest)
}
