package hostimage

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type downloadRoundTrip func(*http.Request) (*http.Response, error)

func (f downloadRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type pausedDownload struct {
	ctx    context.Context
	prefix string
}

func (b *pausedDownload) Read(p []byte) (int, error) {
	if b.prefix != "" {
		n := copy(p, b.prefix)
		b.prefix = b.prefix[n:]
		return n, nil
	}
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}
func (*pausedDownload) Close() error { return nil }

func TestSystemDownloadStopsWhenResponseStalls(t *testing.T) {
	for _, headers := range []bool{false, true} {
		t.Run(map[bool]string{false: "headers", true: "body"}[headers], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				file, err := os.CreateTemp(t.TempDir(), "partial")
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				transport := downloadRoundTrip(func(r *http.Request) (*http.Response, error) {
					if !headers {
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: &pausedDownload{ctx: r.Context(), prefix: "abc"}, ContentLength: 6}, nil
				})
				start := time.Now()
				err = download(t.Context(), Plan{Host: Identity{System: "windows-11"}, URL: "http://download.invalid/image", Bytes: 6}, file, 0, io.Discard, transport)
				if err == nil || time.Since(start) > 65*time.Second {
					t.Fatalf("stalled image remained blocked: elapsed=%v error=%v", time.Since(start), err)
				}
				if headers {
					data, err := os.ReadFile(file.Name())
					if err != nil || string(data) != "abc" {
						t.Fatalf("partial progress lost: %q %v", data, err)
					}
				}
			})
		})
	}
}

type slowDownload struct{ chunks int }

func (b *slowDownload) Read(p []byte) (int, error) {
	if b.chunks == 0 {
		return 0, io.EOF
	}
	time.Sleep(45 * time.Second)
	b.chunks--
	return copy(p, "x"), nil
}
func (*slowDownload) Close() error { return nil }

func TestSystemDownloadKeepsActiveSlowTransfers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		file, err := os.CreateTemp(t.TempDir(), "partial")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		transport := downloadRoundTrip(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: &slowDownload{chunks: 3}, ContentLength: 3}, nil
		})
		var progress strings.Builder
		err = download(t.Context(), Plan{Host: Identity{System: "windows-11"}, URL: "http://download.invalid/image", Bytes: 3}, file, 0, &progress, transport)
		if err != nil {
			t.Fatalf("active slow download interrupted: %v", err)
		}
		data, err := os.ReadFile(file.Name())
		if err != nil || string(data) != "xxx" {
			t.Fatalf("slow download incomplete: %q %v", data, err)
		}
	})
}

func TestSystemDownloadRestartsIdleWindowAfterHeaders(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		file, err := os.CreateTemp(t.TempDir(), "partial")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		transport := downloadRoundTrip(func(r *http.Request) (*http.Response, error) {
			time.Sleep(59 * time.Second)
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: &slowDownload{chunks: 1}, ContentLength: 1}, nil
		})
		start := time.Now()
		err = download(t.Context(), Plan{Host: Identity{System: "windows-11"}, URL: "http://download.invalid/image", Bytes: 1}, file, 0, io.Discard, transport)
		if err != nil {
			t.Fatalf("response headers did not renew activity before the first body byte: elapsed=%v error=%v", time.Since(start), err)
		}
		data, err := os.ReadFile(file.Name())
		if err != nil || string(data) != "x" || time.Since(start) != 104*time.Second {
			t.Fatalf("slow response incomplete: %q elapsed=%v error=%v", data, time.Since(start), err)
		}
	})
}
