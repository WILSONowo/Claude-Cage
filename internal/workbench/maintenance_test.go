package workbench

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
)

func TestMaintenanceRequiresAuthenticationAndSoftwareSource(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("installer credential reached software origin")
		}
		_, _ = io.WriteString(w, "package bytes")
	}))
	defer upstream.Close()
	destination, _ := url.Parse(upstream.URL)
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "deb.debian.org:80" && address != "deb.nodesource.com:80" && address != "archive.ubuntu.com:80" && address != "security.ubuntu.com:80" && address != "ports.ubuntu.com:80" {
			return nil, errors.New("unexpected destination")
		}
		return (&net.Dialer{}).DialContext(ctx, network, destination.Host)
	}
	proxy := &maintenanceProxy{token: "fixture-only", ctx: context.Background(), dial: dial, connections: map[net.Conn]bool{}, transport: &http.Transport{Proxy: nil, DialContext: dial}}
	server := httptest.NewServer(proxy)
	defer server.Close()
	defer proxy.close()
	gate, err := cage.NewEgressGate(cage.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		target, method string
		auth           bool
		status         int
	}{
		{"http://deb.debian.org/debian/pool/file.deb", "GET", false, 407},
		{"http://example.com/private", "GET", true, 403},
		{"http://127.0.0.1/private", "GET", true, 403},
		{"http://deb.debian.org:8080/private", "GET", true, 403},
		{"http://deb.debian.org/debian/pool/file.deb", "POST", true, 405},
		{"http://deb.debian.org/debian/pool/file.deb", "GET", true, 200},
		{"http://deb.nodesource.com/node_24.x/dists/nodistro/InRelease", "GET", true, 200},
		{"http://archive.ubuntu.com/ubuntu/dists/jammy/InRelease", "GET", true, 200},
		{"http://security.ubuntu.com/ubuntu/dists/jammy-security/InRelease", "GET", true, 200},
		{"http://ports.ubuntu.com/ubuntu-ports/dists/jammy/InRelease", "GET", true, 200},
	} {
		proxyURL, _ := url.Parse(server.URL)
		if test.auth {
			proxyURL.User = url.UserPassword("cage-install", "fixture-only")
		}
		transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
		client := &http.Client{Transport: transport, Timeout: time.Second}
		request, _ := http.NewRequest(test.method, test.target, nil)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		transport.CloseIdleConnections()
		if response.StatusCode != test.status {
			t.Fatalf("%s: %d", test.target, response.StatusCode)
		}
		if test.status == 200 && string(body) != "package bytes" {
			t.Fatal("download bytes changed")
		}
	}
	if calls.Load() != 5 {
		t.Fatal("rejected request reached origin")
	}
	if gate.Status().Mode != cage.GateClosed {
		t.Fatal("maintenance changed business gate")
	}
}

func TestUbuntuDependencyFallsBackToSameOriginHTTPSOnForbidden(t *testing.T) {
	const host = "archive.ubuntu.com"
	const resource = "/ubuntu/pool/main/g/guest.deb"
	var calls atomic.Int32
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Host != host || r.URL.Path != resource || r.Header.Get("Range") != "bytes=0-3" || r.Header.Get("Proxy-Authorization") != "" {
			t.Errorf("unexpected HTTPS retry: host=%s path=%s range=%q", r.Host, r.URL.Path, r.Header.Get("Range"))
		}
		w.WriteHeader(http.StatusPartialContent)
		io.WriteString(w, "data")
	}))
	defer origin.Close()
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "proxy policy", http.StatusForbidden)
	}))
	defer denied.Close()
	transport := origin.Client().Transport.(*http.Transport).Clone()
	// The isolated TLS origin presents httptest's certificate for example.com.
	transport.TLSClientConfig.ServerName = "example.com"
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		var target string
		switch address {
		case host + ":80":
			target = denied.Listener.Addr().String()
		case host + ":443":
			target = origin.Listener.Addr().String()
		default:
			return nil, fmt.Errorf("unexpected target %q", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, target)
	}
	defer transport.CloseIdleConnections()
	proxy := &maintenanceProxy{ctx: context.Background(), token: "test", transport: transport}
	request := httptest.NewRequest(http.MethodGet, "http://"+host+":80"+resource, nil)
	request.Header.Set("Range", "bytes=0-3")
	request.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("cage-install:test")))
	reply := httptest.NewRecorder()
	proxy.ServeHTTP(reply, request)
	if reply.Code != http.StatusPartialContent || reply.Body.String() != "data" || calls.Load() != 1 {
		t.Fatalf("download: status=%d HTTPS requests=%d", reply.Code, calls.Load())
	}
}

func TestMaintenanceClosesTLSConnectionsAndRefusesBusinessHosts(t *testing.T) {
	proxy := &maintenanceProxy{token: "fixture", ctx: context.Background(), connections: map[net.Conn]bool{}, transport: &http.Transport{}}
	proxy.dial = func(context.Context, string, string) (net.Conn, error) {
		a, b := net.Pipe()
		go func() { defer b.Close(); _, _ = io.Copy(b, b) }()
		return a, nil
	}
	server := httptest.NewServer(proxy)
	defer server.Close()
	defer proxy.close()
	address, _ := url.Parse(server.URL)
	connection, err := net.Dial("tcp", address.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
	auth := base64.StdEncoding.EncodeToString([]byte("cage-install:fixture"))
	_, _ = fmt.Fprintf(connection, "CONNECT deb.debian.org:443 HTTP/1.1\r\nHost: deb.debian.org:443\r\nProxy-Authorization: Basic %s\r\n\r\n", auth)
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != 200 {
		t.Fatal(response, err)
	}
	_, _ = connection.Write([]byte("abc"))
	bytes := make([]byte, 3)
	if _, err = io.ReadFull(reader, bytes); err != nil || string(bytes) != "abc" {
		t.Fatal("tunnel failed", err)
	}
	proxy.close()
	if _, err = reader.ReadByte(); err == nil {
		t.Fatal("maintenance left a live tunnel")
	}
	for _, address := range []string{"claude.ai:443", "api.anthropic.com:443", "deb.debian.org:22", "127.0.0.1:443", "github.com.evil.test:443"} {
		if maintenanceDestination(address, true) {
			t.Fatal("business or non-HTTPS destination accepted", address)
		}
	}
	for _, host := range []string{"mirrors.nju.edu.cn", "mirrors.ustc.edu.cn", "cdn.npmmirror.com", "api.snapcraft.io", "storage.snapcraftcontent.com", "canonical-lgw01.cdn.snapcraftcontent.com", "canonical-lcy01.cdn.snapcraftcontent.com", "canonical-lcy02.cdn.snapcraftcontent.com", "canonical-bos01.cdn.snapcraftcontent.com", "cloudfront.cdn.snapcraftcontent.com", "codeload.github.com"} {
		if !maintenanceDestination(host+":443", true) || maintenanceDestination(host+":80", false) || maintenanceDestination(host+".evil.test:443", true) {
			t.Fatalf("unexpected mirror policy for %s", host)
		}
	}
}

func TestMaintenanceScriptUsesPrivateTemporaryConfiguration(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the installer Bash script runs in the Linux guest, not the Windows host")
	}
	shell, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	command := exec.Command(shell, "-se")
	command.Stdin = strings.NewReader(maintenanceScript(`test -s "$CAGE_APT_CONFIG"
test "$http_proxy" = "$CAGE_INSTALL_PROXY"
test "$(umask)" = 0022
printf '%s' "$CAGE_APT_CONFIG"
`, "fixture-token"))
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(string(output)); !os.IsNotExist(err) {
		t.Fatal("maintenance credential was retained")
	}
}
