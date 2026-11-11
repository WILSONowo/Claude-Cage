package hostproxy

import (
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestGnomeAuthenticatedProxyDownloads(t *testing.T) {
	const user = `company\user@example`
	const password = " space:'@/\\secret "
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != expected {
			w.WriteHeader(http.StatusProxyAuthRequired)
			return
		}
		_, _ = io.WriteString(w, "downloaded through authenticated proxy")
	}))
	defer proxy.Close()
	host, port, err := net.SplitHostPort(proxy.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	settings := fmt.Sprintf("org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy use-same-proxy true\norg.gnome.system.proxy.http host '%s'\norg.gnome.system.proxy.http port %s\norg.gnome.system.proxy.http use-authentication true\norg.gnome.system.proxy.http authentication-user %s\norg.gnome.system.proxy.http authentication-password %s\n", host, port, strconv.Quote(user), strconv.Quote(password))
	req, _ := http.NewRequest(http.MethodGet, "http://download.invalid/image", nil)
	selected, err := gnomeProxy(req, settings)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: http.ProxyURL(selected)}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("system proxy credentials were not applied, got HTTP %d", response.StatusCode)
	}
	secure, _ := http.NewRequest(http.MethodGet, "https://download.invalid/image", nil)
	u, err := gnomeProxy(secure, settings)
	if err != nil || u == nil || u.User == nil || u.User.Username() != user {
		t.Fatal("shared HTTP proxy lost authentication for HTTPS", err)
	}
	if got, ok := u.User.Password(); !ok || got != password {
		t.Fatal("proxy password changed during URL encoding")
	}
	settings = strings.Replace(settings, "use-authentication true", "use-authentication false", 1)
	u, err = gnomeProxy(req, settings)
	if err != nil || u == nil || u.User != nil {
		t.Fatal("disabled proxy authentication was sent", err)
	}
}

func TestGnomeProxyParsesQuotedCredentials(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "http://download.invalid/image", nil)
	settings := `org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 7890
org.gnome.system.proxy.http use-authentication true
org.gnome.system.proxy.http authentication-user ' user '
org.gnome.system.proxy.http authentication-password 'quote\'and\\slash'`
	u, err := gnomeProxy(req, settings)
	if err != nil || u == nil || u.User == nil || u.User.Username() != " user " {
		t.Fatal("quoted system credentials lost whitespace", err)
	}
	if value, _ := u.User.Password(); value != "quote'and\\slash" {
		t.Fatal("quoted system credentials lost escapes")
	}
}
