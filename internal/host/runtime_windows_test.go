package host

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func TestHideCommandWindowPreservesProcessAttributes(t *testing.T) {
	attributes := &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	cmd := &exec.Cmd{SysProcAttr: attributes}
	HideCommandWindow(cmd)
	if cmd.SysProcAttr != attributes || !attributes.HideWindow || attributes.CreationFlags != windows.CREATE_NEW_PROCESS_GROUP|windows.CREATE_NO_WINDOW {
		t.Fatalf("background command attributes changed: %+v", cmd.SysProcAttr)
	}
}

func TestHiddenCommandHasNoConsoleAndCapturesOutput(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestHiddenCommandChild$")
	cmd.Env = append(os.Environ(), "CAGE_HIDDEN_COMMAND_TEST=1")
	HideCommandWindow(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "console=0") || !strings.Contains(string(output), "stderr-captured") {
		t.Fatalf("hidden child: %s, %v", output, err)
	}
}

func TestHiddenCommandChild(t *testing.T) {
	if os.Getenv("CAGE_HIDDEN_COMMAND_TEST") != "1" {
		return
	}
	window, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow").Call()
	fmt.Printf("console=%d\n", window)
	fmt.Fprintln(os.Stderr, "stderr-captured")
}

func TestBundledHelperWithIncompletePathExt(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PATH", root)
	t.Setenv("PATHEXT", ".CPL")
	if err := os.WriteFile(filepath.Join(root, "qemu-img.exe"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("qemu-img"); err == nil {
		t.Fatal("expected incomplete PATHEXT to hide helper")
	}
	for i := 0; i < 2; i++ {
		if err := ensureWindowsExeExtension(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := exec.LookPath("qemu-img"); err != nil || os.Getenv("PATHEXT") != ".EXE;.CPL" {
		t.Fatal(err, os.Getenv("PATHEXT"))
	}
}
