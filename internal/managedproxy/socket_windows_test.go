package managedproxy

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/sylvinus/agent-vm/internal/host"
	"go.yaml.in/yaml/v3"
)

func TestWindowsSocketLookupAcrossTemp(t *testing.T) {
	if profile := os.Getenv("CAGE_TEST_SOCKET_LOOKUP"); profile != "" {
		var response struct{ Ready bool }
		if err := API(context.Background(), profile, "GET", "/probe", nil, &response); err != nil || !response.Ready {
			t.Fatalf("second process could not contact core: %v", err)
		}
		return
	}
	profile := t.TempDir()
	stable := Socket(profile)
	if _, err := controlSocketForDial(profile); err == nil {
		t.Fatal("an unstarted profile has a socket")
	}
	if _, err := os.Stat(filepath.Dir(stable)); !os.IsNotExist(err) {
		t.Fatalf("read-only lookup created its directory: %v", err)
	}
	// Place the legacy fixture on the local volume to exercise real Windows
	// AF_UNIX transport even when a runner's TEMP does not support sockets.
	temp, err := os.MkdirTemp(".", "socket-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(temp)
	base, err := filepath.Abs(temp)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(filepath.Clean(profile)))
	legacy := filepath.Join(base, fmt.Sprintf("cage-proxy-%x", hash[:8]), "control.sock")
	for _, test := range []struct{ name, path string }{{"legacy", legacy}, {"deterministic", stable}} {
		t.Run(test.name, func(t *testing.T) {
			if test.path == stable {
				dir, err := host.PrivateSocketDir(profile, len(`\proxy.sock`), true)
				if err != nil || filepath.Join(dir, "proxy.sock") != stable {
					t.Fatalf("creation and lookup disagreed: %v", err)
				}
				t.Cleanup(func() { _ = os.Remove(dir) })
			} else if err := host.EnsurePrivateDir(filepath.Dir(legacy)); err != nil {
				t.Fatal(err)
			}
			config := filepath.Join(Dir(profile), "config.yaml")
			wire, err := yaml.Marshal(map[string]string{"external-controller-unix": test.path})
			if err != nil {
				t.Fatal(err)
			}
			if err := Write(config, wire); err != nil {
				t.Fatal(err)
			}
			l, err := net.Listen("unix", test.path)
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"Ready":true}`)) })}
			go server.Serve(l)
			t.Cleanup(func() { _ = server.Close() })
			child := exec.Command(os.Args[0], "-test.run=^TestWindowsSocketLookupAcrossTemp$")
			other := filepath.Dir(stable)
			// Put the socket beneath a foreign caller's TEMP; an
			// exclusion based on that environment would disagree about the socket.
			child.Env = append(os.Environ(), "TEMP="+other, "TMP="+other, "CAGE_TEST_SOCKET_LOOKUP="+profile)
			if output, err := child.CombinedOutput(); err != nil {
				t.Fatalf("%v: %s", err, output)
			}
			if test.path == legacy {
				if _, err := os.Stat(filepath.Dir(stable)); !os.IsNotExist(err) {
					t.Fatal("lookup of old core created new socket directory")
				}

				badProfile := t.TempDir()
				if err := Write(filepath.Join(Dir(badProfile), "config.yaml"), wire); err != nil {
					t.Fatal(err)
				}
				if _, err := controlSocketForDial(badProfile); err == nil {
					t.Fatal("one profile connected to another profile's old socket")
				}
			}
		})
	}
}
