package managedproxy

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
)

func TestAPIPreservesTransportCause(t *testing.T) {
	profile := t.TempDir()
	err := API(context.Background(), profile, "GET", "/private-node?token=private-token", nil, nil)
	var request *url.Error
	var operation *net.OpError
	if !errors.As(err, &request) || !errors.As(err, &operation) {
		t.Fatalf("transport cause was lost: %v", err)
	}
	for _, private := range []string{profile, Socket(profile), "private-node", "private-token"} {
		if strings.Contains(err.Error(), private) {
			t.Fatalf("error exposed private request details: %v", err)
		}
	}
}

func TestAPIPreservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := API(ctx, t.TempDir(), "GET", "/configs", nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation cause was lost: %v", err)
	}
}

func TestCoreErrorHidesPrivateDetails(t *testing.T) {
	cause := &url.Error{Op: "GET", URL: "https://private-user:private-password@example.invalid/private-node?token=private-token", Err: &net.OpError{
		Op: "dial", Net: "unix", Addr: &net.UnixAddr{Name: "/private/home/control.sock", Net: "unix"},
		Err: &os.SyscallError{Syscall: "connect", Err: syscall.EINVAL},
	}}
	client := &http.Client{Transport: coreRoundTripper(func(*http.Request) (*http.Response, error) { return nil, cause })}
	err := apiWithClient(context.Background(), client, "GET", "/private-node?token=private-token", nil, nil)
	var request *url.Error
	if !errors.Is(err, syscall.EINVAL) || !errors.As(err, &request) || !errors.Is(err, cause) {
		t.Fatal("original error chain was not preserved")
	}
	message := err.Error()
	if !strings.Contains(message, fmt.Sprintf("errno %d", syscall.EINVAL)) {
		t.Fatalf("numeric cause missing: %s", message)
	}
	store := diagnostics.New(t.TempDir())
	if err := store.Record("error", "proxy", message); err != nil {
		t.Fatal(err)
	}
	var exported bytes.Buffer
	if err := store.Export(&exported, "test", nil, "offline"); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(exported.Bytes()), int64(exported.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range archive.File {
		r, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(file.Name, "logs/") && bytes.Contains(b, []byte("api.transport")) {
			found = true
		}
		message += string(b)
	}
	if !found {
		t.Fatal("export omitted the recorded API failure")
	}
	for _, private := range []string{"private-user", "private-password", "example.invalid", "private-node", "private-token", "/private/home/control.sock"} {
		if strings.Contains(message, private) || strings.Contains(diagnostics.Redact(message), private) {
			t.Fatalf("private detail reached error/log text: %s", message)
		}
	}
}

type coreRoundTripper func(*http.Request) (*http.Response, error)

func (f coreRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAPIRequestAndResponse(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &http.Client{Transport: coreRoundTripper(func(r *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(r.Body)
		if err != nil || r.Method != "PATCH" || r.URL.Path != "/configs" || r.Context() != ctx || string(body) != `{"enabled":true}` {
			t.Fatal("request method, path, context or JSON body was not preserved")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"enabled":true}`))}, nil
	})}
	var reply struct{ Enabled bool }
	if err := apiWithClient(ctx, client, "PATCH", "/configs", map[string]bool{"enabled": true}, &reply); err != nil || !reply.Enabled {
		t.Fatalf("valid API response was not decoded: %v", err)
	}
}

func TestAPIResponseFailures(t *testing.T) {
	for _, tc := range []struct {
		name, stage string
		status      int
		body        string
	}{
		{"HTTP status", "api.http-503", 503, "private-response-token"},
		{"invalid JSON", "api.decode", 200, "private-response-token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: coreRoundTripper(func(_ *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			var reply any
			err := apiWithClient(context.Background(), client, "GET", "/configs", nil, &reply)
			var failure *coreError
			if !errors.As(err, &failure) || failure.stage != tc.stage || strings.Contains(err.Error(), tc.body) {
				t.Fatalf("unexpected or unsafe response failure: %v", err)
			}
			if tc.stage == "api.decode" {
				var syntax *json.SyntaxError
				if !errors.As(err, &syntax) {
					t.Fatalf("decode cause was lost: %v", err)
				}
			}
		})
	}
}

func TestAPIPreservesDeadline(t *testing.T) {
	client := &http.Client{Transport: coreRoundTripper(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := apiWithClient(ctx, client, "GET", "/configs", nil, nil)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatalf("deadline cause was lost: %v", err)
	}
}

func TestReadinessReportsFirstFailure(t *testing.T) {
	const validConfig = `{"mixed-port":17896,"interface-name":"physical-test","unified-delay":true}`
	for _, tc := range []struct {
		name, bound, config, group, stage string
		requests                          []string
	}{
		{"unreadable binding", "", "", "", "readiness.bound-interface", nil},
		{"empty binding", "{}", "", "", "readiness.bound-interface", nil},
		{"configs API", "interface-name: physical-test", "invalid", "", "readiness.configs", []string{"/configs"}},
		{"port before other predicates", "interface-name: physical-test", `{}`, "", "readiness.port", []string{"/configs"}},
		{"interface before unified delay", "interface-name: physical-test", `{"mixed-port":17896}`, "", "readiness.interface", []string{"/configs"}},
		{"unified delay", "interface-name: physical-test", `{"mixed-port":17896,"interface-name":"physical-test"}`, "", "readiness.unified-delay", []string{"/configs"}},
		{"group API", "interface-name: physical-test", validConfig, "invalid", "readiness.group", []string{"/configs", "/proxies/CAGE"}},
		{"selection", "interface-name: physical-test", validConfig, `{"now":"private-other-node"}`, "readiness.selection", []string{"/configs", "/proxies/CAGE"}},
		{"ready", "interface-name: physical-test", validConfig, `{"now":"private-selected-node"}`, "", []string{"/configs", "/proxies/CAGE"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := t.TempDir()
			if tc.bound != "" {
				if err := Write(filepath.Join(Dir(profile), "config.yaml"), []byte(tc.bound)); err != nil {
					t.Fatal(err)
				}
			}
			var requests []string
			client := &http.Client{Transport: coreRoundTripper(func(r *http.Request) (*http.Response, error) {
				requests = append(requests, r.URL.Path)
				body := tc.group
				if r.URL.Path == "/configs" {
					body = tc.config
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			s := Store{Port: 17896, Selected: "private-selected-node"}
			err := checkRunningWithAPI(context.Background(), profile, s, func(ctx context.Context, _, method, path string, body, reply any) error {
				return apiWithClient(ctx, client, method, path, body, reply)
			})
			var failure *coreError
			if tc.stage == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.As(err, &failure) || failure.stage != tc.stage {
				t.Fatalf("got %v, want stage %s", err, tc.stage)
			}
			if err != nil && (strings.Contains(err.Error(), "private-") || strings.Contains(err.Error(), profile)) {
				t.Fatalf("private readiness data leaked: %v", err)
			}
			if !reflect.DeepEqual(requests, tc.requests) {
				t.Fatalf("readiness request order = %v, want %v", requests, tc.requests)
			}
		})
	}
}
