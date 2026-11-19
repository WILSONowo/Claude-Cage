//go:build windows

package workbench

import (
	"context"
	"errors"
	"net/http"

	"path/filepath"

	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/vm"
)

// A running QEMU can outlive its hostagent or the Cage readiness marker.
// Check the local profile's guest before handing off even an idle controller.
func updateQEMUInstances(profile string) (map[string]int, error) {
	if containerenv.Configured(profile) {
		return nil, nil
	}
	if binding, err := guestos.LoadWindowsProfile(profile); err != nil || binding != nil {
		return nil, err
	}
	dirs := make(map[string]int)
	for _, name := range []string{cage.InstanceName(profile, cage.EnvironmentDir(profile)), "base-building"} {
		dir := filepath.Join(profile, "state", "lima", name)
		pid, err := vm.UpdateQEMUPID(dir)
		if err != nil {
			return nil, err
		}
		if pid != 0 {
			dirs[dir] = pid
		}
	}
	return dirs, nil
}

func (c *controllerClient) stopUpdateGuests() error {
	dirs, err := updateQEMUInstances(c.profile)
	if err != nil || len(dirs) == 0 {
		return err
	}
	if c.connectionID != "local" {
		return errors.New("无法核对本地环境，请在原 Cage 窗口中停止环境后重试")
	}
	var state struct {
		VMRunning *bool `json:"vm_running"`
		Job       Job   `json:"job"`
	}
	// Use the original controller's account/session and local connection checks
	// before touching any guest. A provisioning job may be replacing the VM.
	status, err := c.call("GET", "/api/status", nil, &state)
	if err != nil {
		return err
	}
	if status != http.StatusOK || state.VMRunning == nil {
		return errors.New("无法核对本地环境状态，未发送关机请求")
	}
	if state.Job.Running {
		return errors.New("环境操作仍在进行，请等待操作结束后重试更新")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	for dir, pid := range dirs {
		if err := vm.StopQEMUForUpdate(ctx, dir, pid); err != nil {
			return err
		}
	}
	return nil
}
