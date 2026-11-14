package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"golang.org/x/crypto/ssh"
)

func TestMacOSBrowserComponentsPreflight(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("POSIX shell is unavailable")
	}
	for _, tc := range []struct {
		name       string
		missing    string
		connection uint32
		update     bool
	}{
		{"current", "", 0, false},
		{"missing_window_module", "macos-browser-window.mjs", 0, true},
		{"missing_check_page", "browser-check.html", 0, true},
		{"transport_failure", "", 255, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resources := t.TempDir()
			for _, name := range []string{"macos-browser-window.mjs", "browser-check.html"} {
				if name != tc.missing {
					if err := os.WriteFile(filepath.Join(resources, name), []byte("fixture"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			var probes, starts atomic.Int32
			guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
				if strings.Contains(command, "browser-check.html") {
					probes.Add(1)
					if tc.connection != 0 {
						return tc.connection, true
					}
					for _, name := range []string{"macos-browser-window.mjs", "browser-check.html"} {
						command = strings.ReplaceAll(command, guestos.MacOSBrowserTools+"/controller/"+name,
							shellescape.Quote(filepath.Join(resources, name)))
					}
					if err := exec.CommandContext(t.Context(), shell, "-c", command).Run(); err != nil {
						var exit *exec.ExitError
						if errors.As(err, &exit) {
							return uint32(exit.ExitCode()), true
						}
						t.Error(err)
						return 1, true
					}
					return 0, true
				}
				if strings.Contains(command, "macos-native-browser.mjs") {
					starts.Add(1)
				}
				return 0, false
			})
			s := guest.s
			_, err := s.nativeBrowserAPI(t.Context(), "GET", "/tabs", nil)
			if probes.Load() != 1 || errors.Is(err, errGuestUpdateRequired) != tc.update {
				t.Fatalf("probes=%d, error=%v", probes.Load(), err)
			}
			if (tc.update || tc.connection != 0) && (err == nil || starts.Load() != 0) {
				t.Fatal("unverified guest launched its browser", err, starts.Load())
			}
			if !tc.update && tc.connection == 0 && (err != nil || starts.Load() != 1) {
				t.Fatal("current guest could not connect", err, starts.Load())
			}
			response := nativeMaintenanceRequest(s, "GET", "/api/status", "")
			var state struct {
				Update bool   `json:"environment_update_required"`
				Error  string `json:"environment_update_error"`
			}
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Update != tc.update {
				t.Fatal("update banner does not match the browser failure", response.Code, response.Body.String())
			}
			if tc.update && !strings.Contains(state.Error, "版本与组件") {
				t.Fatal("missing actionable component recovery", state.Error)
			}
		})
	}
}

func TestMacOSBrowserComponentsCancellationDoesNotRequestUpdate(t *testing.T) {
	s := newMacWorkspaceGuest(t).s
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.macOSBrowserObservation(ctx, cage.DefaultConfig(), false); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was replaced by a browser observation error", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.guestUpdateRequired || s.guestUpdateError != "" {
		t.Fatal("cancellation incorrectly marked components as outdated")
	}
}

func TestMacOSBrowserAuditPreservesComponentRecoveryAndRetries(t *testing.T) {
	var updated atomic.Bool
	guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
		if strings.Contains(command, "browser-check.html") {
			if updated.Load() {
				return 0, true
			}
			return 78, true
		}
		return 0, false
	})
	s := guest.s
	_, err := s.macOSBrowserObservation(t.Context(), cage.DefaultConfig(), true)
	if !errors.Is(err, errGuestUpdateRequired) || !strings.Contains(err.Error(), "版本与组件") {
		t.Fatal("component failure was hidden by a generic browser observation error", err)
	}
	updated.Store(true)
	if _, err = s.nativeBrowserAPI(t.Context(), "GET", "/tabs", nil); err != nil {
		t.Fatal("failed preflight poisoned a later connection", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.guestUpdateRequired {
		t.Fatal("a browser probe cleared the full component verification requirement")
	}
}
