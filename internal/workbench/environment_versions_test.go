package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
)

func TestGuestConnectionRequiresSuccessfulMatchingManifest(t *testing.T) {
	required := cage.RequiredGuestManifest()
	for _, name := range []string{"current", "missing", "old-revision", "old-protocol", "broken", "interrupted", "during-read"} {
		t.Run(name, func(t *testing.T) {
			manifest := required
			if name == "old-revision" {
				manifest.Revision = "previous"
			}
			if name == "old-protocol" {
				manifest.Protocol++
			}
			encoded, _ := json.Marshal(manifest)
			if name == "interrupted" {
				encoded = []byte(`{"updating":true}`)
			}
			if name == "during-read" {
				encoded = append(encoded, []byte("\nupdating")...)
			}
			if name == "missing" {
				encoded = []byte("null")
			}
			if name == "broken" {
				encoded = []byte("{")
			}
			credentials, current, err := parseGuestConnection(append([]byte("{\"token\":\"guest-test\"}\npassword\n"), encoded...))
			if name == "current" {
				if err != nil || current == nil || credentials.Token != "guest-test" || credentials.VNCPassword != "password" {
					t.Fatal(current, err)
				}
			} else if name == "broken" || name == "missing" || name == "interrupted" || name == "during-read" {
				if !errors.Is(err, errGuestRecoveryRequired) {
					t.Fatalf("recovery required: %v", err)
				}
			} else if !errors.Is(err, errGuestUpdateRequired) {
				t.Fatalf("stale guest accepted: %v", err)
			}
		})
	}
}

// Exercise the same guest command and parser as attach, with local files
// standing in for the guest's private directory and no network or VM.
func TestGuestManifestRecoverySnapshot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("executes the Debian guest shell")
	}
	required, _ := json.Marshal(cage.RequiredGuestManifest())
	for _, state := range []string{"missing", "empty", "broken", "components.pending", "components.updating", "interrupted-during-read"} {
		t.Run(state, func(t *testing.T) {
			dir := t.TempDir()
			credentials := filepath.Join(dir, ".config", "claude-cage")
			if err := os.MkdirAll(credentials, 0700); err != nil {
				t.Fatal(err)
			}
			write := func(path string, data []byte) {
				t.Helper()
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(dir, "browser-control.json"), []byte("{\"token\":\"fixture\"}\n"))
			write(filepath.Join(credentials, "browser-password"), []byte("fixture\n"))
			receipt := filepath.Join(dir, "components.json")
			if state != "missing" {
				write(receipt, required)
			}
			switch state {
			case "empty":
				write(receipt, nil)
			case "broken":
				write(receipt, []byte("{"))
			case "components.updating", "components.pending":
				write(filepath.Join(dir, state), nil)
			}
			read := func(interrupt bool) error {
				helper := `sudo() { "$@"; }` + "\n"
				if interrupt {
					helper = `sudo() { "$@" || return; if [ "$1" = cat ] && [ "$2" = "$HOME/components.json" ]; then touch "$HOME/components.updating"; fi; }` + "\n"
				}
				script := helper + strings.ReplaceAll(guestConnectionSnapshot, "/etc/claude-cage", dir)
				cmd := exec.Command("bash", "-c", script)
				cmd.Env = append(os.Environ(), "HOME="+dir)
				data, err := cmd.Output()
				if err != nil {
					t.Fatal(err)
				}
				creds, _, err := parseGuestConnection(data)
				if creds.Token != "fixture" || creds.VNCPassword != "fixture" {
					t.Fatal("lost credentials during manifest recovery")
				}
				return err
			}
			if err := read(state == "interrupted-during-read"); !errors.Is(err, errGuestRecoveryRequired) {
				t.Fatalf("wanted recovery, got %v", err)
			}
			write(receipt, required)
			for _, marker := range []string{"components.pending", "components.updating"} {
				if err := os.Remove(filepath.Join(dir, marker)); err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
			}
			if err := read(false); err != nil {
				t.Fatalf("recovered snapshot: %v", err)
			}
		})
	}
}

func grantedToolUpdateServer(t *testing.T) (*Server, *cage.EgressGate) {
	t.Helper()
	s, gate := interfaceMonitorServer(t)
	grantTestGate(t, gate)
	s.ready = true
	required := cage.RequiredGuestManifest()
	s.guestManifest = &required
	s.setJobForTest(Job{ID: "tools", Kind: "environment-tools", Running: true})
	s.publishGate(gate.Status())
	return s, gate
}

func grantTestGate(t *testing.T, gate *cage.EgressGate) {
	t.Helper()
	state := gate.Status()
	report := cage.SafetyReport{Policy: cage.SafetyPolicyVersion, ID: "tool-update-test", RunID: state.RunID, CheckID: state.CheckID, Configuration: state.Configuration, CreatedAt: time.Now()}
	for _, id := range []string{"egress_policy", "proxy_transport", "dns_transport", "guest_settings", "browser_settings", "filesystem_boundary", "management_boundary", "fail_closed", "udp_policy", "ipv6_policy", "exit_consistency"} {
		report.Checks = append(report.Checks, cage.SafetyCheck{ID: id, Title: id, Critical: true, State: cage.CheckPassed, Evidence: "synthetic isolated fixture", CheckedAt: report.CreatedAt})
	}
	if err := gate.Grant(report); err != nil {
		t.Fatal(err)
	}
}

func TestToolUpdateLeaseHonorsPauseStopAndConfigurationAtRenewal(t *testing.T) {
	for _, jobKind := range []string{"environment-tools", "claude-desktop-install"} {
		t.Run(jobKind, func(t *testing.T) {
			for _, condition := range []string{"allowed", "paused", "stop", "configuration-changed"} {
				t.Run(condition, func(t *testing.T) {
					s, gate := grantedToolUpdateServer(t)
					s.setJobForTest(Job{ID: "tools", Kind: jobKind, Running: true})
					client, err := s.gateClient()
					if err != nil {
						t.Fatal(err)
					}
					before := gate.Status()
					// Windows can grant and renew within the same wall-clock tick.
					// Advance past the grant tick before requiring a later deadline.
					for !time.Now().Add(cage.GateLease).After(before.Until) {
						time.Sleep(time.Millisecond)
					}
					switch condition {
					case "paused":
						if err := s.pauseNetworkNow("test user pause"); err != nil {
							t.Fatal(err)
						}
					case "stop":
						s.setJobForTest(Job{ID: "stop", Kind: "stop", Running: true})
					case "configuration-changed":
						cfg, err := loadConfig(s.configPath)
						if err != nil {
							t.Fatal(err)
						}
						cfg.Timezone = "Etc/UTC"
						if cfg.Fingerprint() == before.Configuration {
							cfg.Timezone = "Asia/Tokyo"
						}
						if err := writePrivate(s.configPath, cfg); err != nil {
							t.Fatal(err)
						}
					}
					s.finishSafetyMonitor(context.Background(), client, before, "192.0.2.1", "")
					after := gate.Status()
					switch condition {
					case "allowed":
						if after.Mode != cage.GateOpen || !after.Until.After(before.Until) {
							t.Fatal("tool update lease was not renewed")
						}
					case "paused", "configuration-changed":
						if after.Mode != cage.GateClosed {
							t.Fatal("denied network was renewed")
						}
					case "stop":
						if after.Until != before.Until {
							t.Fatal("stopping job allowed a lease renewal")
						}
					}
				})
			}
		})
	}
}

func TestToolUpdateDoesNotRestorePausedOrExpiredNetworking(t *testing.T) {
	for _, paused := range []bool{true, false} {
		s, gate := grantedToolUpdateServer(t)
		if paused {
			if err := s.pauseNetworkNow("manual"); err != nil {
				t.Fatal(err)
			}
		} else {
			gate.Close("expired")
		}
		s.mu.Lock()
		allowed := s.toolsNetworkAllowedLocked()
		s.mu.Unlock()
		if !allowed {
			t.Fatal("business network pause blocked maintenance")
		}
		if gate.Status().Mode != cage.GateClosed {
			t.Fatal("tool update restored closed network")
		}
	}
}

func TestEnvironmentVersionRoutesRequireHostSession(t *testing.T) {
	s := testServer(t)
	for _, path := range []string{"/api/environment/versions", "/api/environment/update", "/api/environment/tools"} {
		method := "POST"
		if strings.HasSuffix(path, "versions") {
			method = "GET"
		}
		if w := request(s, method, path, s.origin, "{}", false); w.Code != 401 {
			t.Fatalf("untrusted version action accepted: %d", w.Code)
		}
	}
	w := request(s, "GET", "/api/environment/versions", s.origin, "", true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"stopped"`) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestVersionQueryPublishesUpdateOnlyWithoutNewerDecision(t *testing.T) {
	s := testServer(t)
	status := func() (bool, string) {
		var v struct {
			Required bool   `json:"environment_update_required"`
			Error    string `json:"environment_update_error"`
		}
		w := request(s, "GET", "/api/status", s.origin, "", true)
		if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
			t.Fatal(w.Code, err)
		}
		return v.Required, v.Error
	}
	begin := func() uint64 {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.guestUpdateGeneration
	}

	// A query that found a stale manifest is published to status.
	s.noteGuestUpdateRequired(begin(), "")
	if required, message := status(); !required || message != errGuestUpdateRequired.Error() {
		t.Fatalf("stale manifest not published: %v %q", required, message)
	}

	// An attach after the query began (here: update finished) wins.
	s.mu.Lock()
	s.setGuestUpdateLocked(false, "")
	s.mu.Unlock()
	stale := begin()
	s.mu.Lock()
	s.setGuestUpdateLocked(true, "环境组件更新尚未完成，请等待结果；失败时可以重试。")
	s.setGuestUpdateLocked(false, "")
	s.mu.Unlock()
	s.noteGuestUpdateRequired(stale, "")
	if required, _ := status(); required {
		t.Fatal("a query started before the update overwrote its result")
	}

	// Never while a maintenance job runs.
	release := make(chan struct{})
	if _, err := s.jobs.submit(&sync.Mutex{}, "environment-update", 0, nil, nil, func() error { <-release; return nil }); err != nil {
		t.Fatal(err)
	}
	s.noteGuestUpdateRequired(begin(), "")
	close(release)
	if required, _ := status(); required {
		t.Fatal("a query during maintenance published its result")
	}
}
