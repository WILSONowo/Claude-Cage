package workbench

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerProxyReleaseRequiresIdleProfile(t *testing.T) {
	profile := t.TempDir()
	install := t.TempDir()
	config := filepath.Join(profile, "config.json")
	lock, err := openControllerLock(profile, os.O_CREATE|os.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := lockController(lock); err != nil {
		t.Fatal(err)
	}
	if _, err := ReleaseOrphanProxyForUpdate(config, install); err == nil || !strings.Contains(err.Error(), "后台正在使用") {
		t.Fatalf("live controller was not preserved: %v", err)
	}
	if err := unlockController(lock); err != nil {
		t.Fatal(err)
	}
	instance := filepath.Join(profile, "state", "lima", "vm")
	if err := os.MkdirAll(instance, 0700); err != nil {
		t.Fatal(err)
	}
	running := filepath.Join(instance, "cage-running.json")
	if err := os.WriteFile(running, []byte(fmt.Sprintf(`{"pid":%d}`, os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReleaseOrphanProxyForUpdate(config, install); err == nil || !strings.Contains(err.Error(), "环境仍在运行") {
		t.Fatalf("live VM record was not preserved: %v", err)
	}
	if err := os.Remove(running); err != nil {
		t.Fatal(err)
	}
	if _, err := ReleaseOrphanProxyForUpdate(config, install); err == nil || !strings.Contains(err.Error(), "缺少代理进程记录") {
		t.Fatalf("missing ownership evidence was accepted: %v", err)
	}
}
