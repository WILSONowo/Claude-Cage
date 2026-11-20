package workbench

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/hostimage"
	"github.com/sylvinus/agent-vm/internal/limaembed"
)

func linuxGuestImagePlan(ctx context.Context, profile, system, arch string) (hostimage.Plan, error) {
	if system != guestos.Ubuntu2204 || arch != "amd64" && arch != "arm64" {
		return hostimage.Plan{}, errors.New("此主机暂不支持所选 Linux 客机镜像")
	}
	template, err := limaembed.ReadImageTemplate(system)
	if err != nil {
		return hostimage.Plan{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return hostimage.Plan{}, err
	}
	identity := hostimage.Identity{System: system, Version: "22.04", Arch: arch}
	// Recreate the pinned image plan an older installer wrote. No download is needed.
	return hostimage.Resolve(ctx, identity, filepath.Join(profile, "state", "guest-media", system), filepath.Join(home, "Downloads"), template, nil)
}

func TestUbuntuGuestChoicesMatchSupportedHostArchitectures(t *testing.T) {
	for _, host := range []struct {
		platform, arch string
		available      bool
	}{
		{"darwin", "arm64", true}, {"windows", "amd64", true}, {"linux", "amd64", true},
		{"darwin", "amd64", false}, {"windows", "arm64", false}, {"linux", "arm64", false},
	} {
		if got := linuxGuestSystems(host.platform, host.arch); (len(got) == 1 && got[0] == guestos.Ubuntu2204) != host.available {
			t.Fatalf("%s/%s: %v", host.platform, host.arch, got)
		}
	}
}

func TestUbuntuCatalogPlanPreservesArchitectureAndResumeChoice(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		plan, err := linuxGuestImagePlan(t.Context(), t.TempDir(), guestos.Ubuntu2204, arch)
		if err != nil || plan.Host.Arch != arch || !strings.Contains(plan.URL, "-"+arch+".img") || plan.Bytes <= 0 {
			t.Fatalf("%s: %+v %v", arch, plan, err)
		}
	}
	s := testServer(t)
	plan, err := linuxGuestImagePlan(t.Context(), s.profile, guestos.Ubuntu2204, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	install := guestos.Installation{Version: 1, ID: uuid.New(), System: guestos.Ubuntu2204, Source: plan, SourceKind: guestos.LinuxImageSource}
	if err := guestos.SaveInstallation(s.profile, install); err != nil {
		t.Fatal(err)
	}
	view, err := s.guestInstallView()
	if err != nil || view.Pending == nil || view.Pending.SourceKind != guestos.LinuxImageSource || !view.Reselect {
		t.Fatalf("cross-host resume: %+v %v", view, err)
	}
	if err := os.MkdirAll(filepath.Join(s.profile, "state", "lima", "base-building"), 0700); err != nil {
		t.Fatal(err)
	}
	view, err = s.guestInstallView()
	if err != nil || view.Reselect {
		t.Fatalf("started disk can be reselected: %+v %v", view, err)
	}
}

func TestFreshGuestCreationOffersOnlyDebian13(t *testing.T) {
	s := testServer(t)
	view, err := s.guestInstallView()
	if err != nil || !view.Fresh || !view.Available || view.System != guestos.Debian13 || len(view.LinuxSystems) != 1 || view.LinuxSystems[0] != guestos.Debian13 {
		t.Fatalf("fresh options: %+v %v", view, err)
	}
	for _, system := range []string{guestos.Ubuntu2204, "ubuntu-24.04", "debian-12", guestos.Windows11, guestos.MacOS} {
		r := httptest.NewRequest(http.MethodPost, "/api/start", strings.NewReader(`{"guest_system":"`+system+`"}`))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: s.cookieName() + "-desktop", Value: trustedViewProof(s.token)})
		w := httptest.NewRecorder()
		s.start(w, r)
		if w.Code != http.StatusConflict || s.jobs.snapshot().ID != "" {
			t.Fatalf("fresh %s: %d %s", system, w.Code, w.Body.String())
		}
	}
	for _, body := range []string{`{"guest_system":"debian-13","media":"custom.iso"}`, `{"guest_system":"debian-13","clone_key":"new-plan"}`} {
		w := request(s, http.MethodPost, "/api/start", s.origin, body, true)
		if w.Code != http.StatusConflict || s.jobs.snapshot().ID != "" {
			t.Fatalf("unexpected media admission: %d %s", w.Code, w.Body.String())
		}
	}
	pending, err := guestos.LoadInstallation(s.profile)
	if err != nil || pending != nil {
		t.Fatalf("new installation record: %+v %v", pending, err)
	}
}

func TestUbuntuBoundSystemCannotBeStartedAsDebian(t *testing.T) {
	s := testServer(t)
	plan, err := linuxGuestImagePlan(t.Context(), s.profile, guestos.Ubuntu2204, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	plan.Path = filepath.Join(s.profile, "ubuntu.img")
	if err := hostimage.WriteLinuxTemplate(filepath.Join(s.profile, "state"), plan); err != nil {
		t.Fatal(err)
	}
	w := request(s, http.MethodPost, "/api/start", s.origin, `{"guest_system":"debian-13"}`, true)
	if w.Code != http.StatusConflict || s.jobs.snapshot().ID != "" {
		t.Fatalf("changed existing Ubuntu: %d %s", w.Code, w.Body.String())
	}
}

func TestCompletedUbuntuUsesOriginalDiskOnImplicitStart(t *testing.T) {
	s := testServer(t)
	state := filepath.Join(s.profile, "state")
	plan, err := linuxGuestImagePlan(t.Context(), s.profile, guestos.Ubuntu2204, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	plan.Path = filepath.Join(s.profile, "ubuntu.img")
	if err := hostimage.WriteLinuxTemplate(state, plan); err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(state, "lima", "base", "diffdisk")
	if err := os.MkdirAll(filepath.Dir(disk), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(disk, []byte("existing-disk"), 0600); err != nil {
		t.Fatal(err)
	}
	view, err := s.guestInstallView()
	if err != nil || view.Fresh || view.Pending != nil {
		t.Fatalf("bound environment presented as new: %+v, %v", view, err)
	}
	s.op.Lock()
	w := request(s, http.MethodPost, "/api/start", s.origin, `{}`, true)
	s.jobs.cancelRunning()
	s.op.Unlock()
	s.jobs.workers.Wait()
	if w.Code != http.StatusOK || s.jobs.snapshot().Kind != "start" {
		t.Fatalf("implicit Ubuntu start: %d %s", w.Code, w.Body.String())
	}
	system, err := s.installedLinuxSystem()
	if err != nil || system != guestos.Ubuntu2204 {
		t.Fatalf("source changed: %q %v", system, err)
	}
	data, err := os.ReadFile(disk)
	if err != nil || string(data) != "existing-disk" {
		t.Fatalf("original disk changed: %v", err)
	}
	if err := os.Remove(filepath.Join(state, "guest-media", "host-system.yaml")); err != nil {
		t.Fatal(err)
	}
	w = request(s, http.MethodPost, "/api/start", s.origin, `{}`, true)
	if w.Code < 400 {
		t.Fatalf("damaged source silently replaced: %d %s", w.Code, w.Body.String())
	}
	data, err = os.ReadFile(disk)
	if err != nil || string(data) != "existing-disk" {
		t.Fatalf("disk after missing source: %v", err)
	}
}
