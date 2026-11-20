package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/sylvinus/agent-vm/internal/cage"
)

func TestBrowserGraphicsSavedOfflineAndPreservedByOlderClients(t *testing.T) {
	s := testServer(t)
	cfg, err := cage.Load(s.configPath)
	if err != nil {
		t.Fatal(err)
	}
	settings := settingsView(cfg, s.preferences)
	want := BrowserGraphics{Backend: "swiftshader", DisableWebGL: true, BlockCanvasRead: true}
	settings.BrowserGraphics = want
	next, prefs, err := proposedSettings(settings, cfg, s.profile)
	if err != nil || next != cfg {
		t.Fatalf("graphics changed the environment or network config: %v", err)
	}
	if err := s.apply(savedProfile{next, prefs}, true); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(s.profile, "workbench.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored Preferences
	if err := json.Unmarshal(data, &stored); err != nil || stored.BrowserGraphics != want {
		t.Fatalf("stored graphics: %+v, %v", stored.BrowserGraphics, err)
	}

	data, err = json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]json.RawMessage
	if err := json.Unmarshal(data, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "browser_graphics")
	data, err = json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	got, ok := s.proposed(w, req)
	if !ok || got.Preferences.BrowserGraphics != want {
		t.Fatalf("legacy form lost graphics: %+v (%s)", got.Preferences.BrowserGraphics, w.Body.String())
	}

	settings.BrowserGraphics = BrowserGraphics{}
	_, prefs, err = proposedSettings(settings, cfg, s.profile)
	if err != nil || prefs.BrowserGraphics != (BrowserGraphics{}) {
		t.Fatal("could not restore graphics defaults", err)
	}
}

func TestBrowserGraphicsRejectUnknownBackendBeforeLaunch(t *testing.T) {
	s := testServer(t)
	cfg := cage.DefaultConfig()
	input := settingsView(cfg, s.preferences)
	input.BrowserGraphics.Backend = "unexpected"
	if _, _, err := proposedSettings(input, cfg, s.profile); err == nil {
		t.Fatal("unexpected backend accepted")
	}
	if err := writePrivate(filepath.Join(s.profile, "workbench.json"), input.Preferences); err != nil {
		t.Fatal(err)
	}
	if err := StartGuestServices(context.Background(), s.configPath, cfg, io.Discard, io.Discard); err == nil || err.Error() != "不支持的浏览器图形后端" {
		t.Fatalf("invalid saved backend: %v", err)
	}
}
