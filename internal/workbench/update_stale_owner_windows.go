package workbench

import (
	"net/http"
	"path/filepath"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

// A 0.1.36 controller can reject both handoff and stop when Windows denies
// OpenProcess on an exited VM owner. After consent, retire the verified stale
// marker and retry the old controller's own VM, job and terminal checks.
func (c *controllerClient) handoffStaleWindowsOwner() (bool, error) {
	if c.launch.Controller.Version != "0.1.36" || c.launch.Controller.Protocol != controlProtocol ||
		c.launch.DesktopGateway || c.launch.ClientOnly || c.launch.ConfigPath == "" ||
		filepath.Dir(c.launch.ConfigPath) != filepath.Clean(c.profile) || containerenv.Configured(c.profile) {
		return false, nil
	}
	if binding, err := guestos.LoadWindowsProfile(c.profile); err != nil || binding != nil {
		return false, err
	}
	if binding, err := guestos.LoadMacOSProfile(c.profile); err != nil || binding != nil {
		return false, err
	}
	if dirs, err := updateQEMUInstances(c.profile); err != nil || len(dirs) != 0 {
		return false, err
	}
	cleared, err := cage.RetireStaleVMOwner(c.profile)
	if err != nil || !cleared {
		return false, err
	}
	status, err := c.call("POST", "/api/handoff", map[string]string{"token": c.record.Token}, nil)
	if err != nil || status != http.StatusOK {
		return false, err
	}
	return true, c.waitForExit()
}
