//go:build e2e && darwin && arm64

package workbench

import (
	"os"
	"testing"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

// Uses only the probe's guest-local, read-only SFTP fixture; no host folder is
// shared. A second run verifies that teardown left the extension usable.
func TestMacOSFSKitProbeMountAndUnmount(t *testing.T) {
	profile := os.Getenv("CAGE_TEST_MACOS_WORKBENCH_PROFILE")
	if profile == "" {
		t.Skip("select a running test guest with CAGE_TEST_MACOS_WORKBENCH_PROFILE")
	}
	binding, err := guestos.LoadMacOSProfile(profile)
	if err != nil || binding == nil {
		t.Fatalf("unavailable macOS test profile: %v", err)
	}
	s := &Server{profile: profile, macosGuest: binding}
	for attempt := 1; attempt <= 2; attempt++ {
		if err := s.checkMacOSSetupProjects(t.Context()); err != nil {
			t.Fatalf("mount/unmount attempt %d: %v", attempt, err)
		}
		if s.macSetupProjectsChecked.IsZero() {
			t.Fatal("successful probe did not record verification")
		}
	}
}
