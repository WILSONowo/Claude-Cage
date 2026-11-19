package vm

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func isWindowsQEMU(pid int, dir, name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	cmd := exec.CommandContext(ctx, filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command",
		`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter 'ProcessId=`+strconv.Itoa(pid)+`').CommandLine | ConvertTo-Json -Compress`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	var command string
	if json.Unmarshal(out, &command) != nil {
		return false
	}
	return windowsQEMUCommandMatches(command, dir, name)
}

func windowsQEMUCommandMatches(command, dir, name string) bool {
	args, err := windows.DecomposeCommandLine(command)
	if err != nil || len(args) == 0 || !strings.EqualFold(filepath.Base(args[0]), "qemu-system-x86_64.exe") {
		return false
	}
	gotName, gotPID := false, false
	for i := 1; i+1 < len(args); i++ {
		switch args[i] {
		case "-name":
			gotName = args[i+1] == "lima-"+name
			i++
		case "-pidfile":
			path := filepath.Clean(args[i+1])
			gotPID = strings.EqualFold(path, filepath.Join(dir, "qemu.pid"))
			if !gotPID && filepath.IsAbs(path) && strings.EqualFold(filepath.Base(path), "qemu.pid") {
				// Storage may be reached through the profile's directory junction.
				want, err := os.Stat(dir)
				actual, pathErr := os.Stat(filepath.Dir(path))
				gotPID = err == nil && pathErr == nil && os.SameFile(want, actual)
			}
			i++
		}
	}
	return gotName && gotPID
}
