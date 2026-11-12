package workbench

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestSessionListClearsUnavailableRunningObservation(t *testing.T) {
	for _, state := range []string{"stopped", "discovery-failed"} {
		for _, route := range []string{"/api/cli/sessions", "/api/mobile/cli/sessions"} {
			t.Run(state+route, func(t *testing.T) {
				s, id, project := metadataFixture(t)
				if _, err := s.mobileCLI.summaries(s.profile, map[string]bool{project: true}, false); err != nil {
					t.Fatal(err)
				}
				s.mobileCLI.running = map[string]bool{id: true}
				s.ready = state != "stopped"
				if state == "discovery-failed" {
					// Fail discovery before starting any guest process.
					if err := os.WriteFile(filepath.Join(s.profile, "claude-accounts.json"), []byte("{"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				w := request(s, http.MethodGet, route, "", "", true)
				var result struct {
					Sessions []mobileSummary `json:"sessions"`
					Notice   string          `json:"notice"`
				}
				if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Sessions) != 1 {
					t.Fatalf("session history unavailable: %d %s", w.Code, w.Body.String())
				}
				if result.Sessions[0].Running || result.Sessions[0].Active {
					t.Fatalf("stale process observation still disables the session: %+v", result.Sessions[0])
				}
				if (result.Notice != "") != (state == "discovery-failed") {
					t.Fatalf("unexpected discovery notice: %q", result.Notice)
				}
			})
		}
	}
}
