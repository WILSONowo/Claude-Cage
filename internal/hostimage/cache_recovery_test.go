package hostimage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareRecoversCorruptManagedCache(t *testing.T) {
	content := []byte("valid image")
	for _, selectedPath := range []bool{false, true} {
		for _, bad := range []string{"wrong image", "short", "longer damaged image"} {
			t.Run(fmt.Sprintf("selected=%t/bytes=%d", selectedPath, len(bad)), func(t *testing.T) {
				cache := t.TempDir()
				plan := Plan{Host: Identity{System: "windows-11", Version: "25H2", Build: "26200.9", Edition: "Professional", Language: "en-US", Arch: "amd64"},
					Version: "25H2", Build: "26200.8", Format: "esd", Bytes: int64(len(content)),
					URL: "http://dl.delivery.mp.microsoft.com/fixture.esd", Digest: fmt.Sprintf("sha256:%x", sha256.Sum256(content))}
				cached := plan.CachedPath(cache)
				if err := os.WriteFile(cached, []byte(bad), 0600); err != nil {
					t.Fatal(err)
				}
				if selectedPath {
					info, _ := os.Stat(cached)
					plan.Path, plan.Modified = cached, info.ModTime().UnixNano()
				}
				requests := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests++
					if r.Header.Get("Range") != "" {
						t.Error("corrupt final cache was reused as a download prefix")
					}
					_, _ = w.Write(content)
				}))
				defer server.Close()
				transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
					return new(net.Dialer).DialContext(ctx, network, server.Listener.Addr().String())
				}}
				defer transport.CloseIdleConnections()
				ready, err := Prepare(t.Context(), cache, plan, io.Discard, transport)
				if err != nil || ready.Path != cached || ready.Digest != plan.Digest {
					t.Fatalf("managed cache never recovers on retry: %+v %v", ready, err)
				}
				if _, err := Prepare(t.Context(), cache, ready, io.Discard, transport); err != nil {
					t.Fatal("repaired cache cannot be reused", err)
				}
				retained, err := filepath.Glob(cached + ".invalid-*")
				if err != nil || len(retained) != 1 || requests != 1 {
					t.Fatalf("retained=%v requests=%d error=%v", retained, requests, err)
				}
				old, err := os.ReadFile(retained[0])
				if err != nil || string(old) != bad {
					t.Fatal("damaged cache was discarded instead of quarantined", err)
				}
				current, err := os.ReadFile(cached)
				if err != nil || !bytes.Equal(current, content) {
					t.Fatal("repaired cache differs from the pinned image", err)
				}
			})
		}
	}
}

func TestPrepareNeverReplacesSelectedExternalImage(t *testing.T) {
	cache, external := t.TempDir(), filepath.Join(t.TempDir(), "chosen.esd")
	if err := os.WriteFile(external, []byte("wrong image"), 0600); err != nil {
		t.Fatal(err)
	}
	plan := Plan{Host: Identity{System: "windows-11", Version: "25H2", Edition: "Professional", Language: "en-US", Arch: "amd64"},
		Version: "25H2", Build: "26200.8", Format: "esd", Bytes: 11, Path: external,
		URL: "http://dl.delivery.mp.microsoft.com/fixture.esd", Digest: fmt.Sprintf("sha256:%x", sha256.Sum256([]byte("valid image")))}
	if _, err := Prepare(t.Context(), cache, plan, io.Discard, nil); err == nil {
		t.Fatal("accepted damaged external image")
	}
	data, err := os.ReadFile(external)
	if err != nil || string(data) != "wrong image" {
		t.Fatal("changed a user-selected source image", err)
	}
}
