package mobilelink

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRelayResponseBodyFailureIsRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprint(w, `{"id":`)
	}))
	defer server.Close()
	_, err := CreateRoom(t.Context(), server.URL, strings.Repeat("t", 32))
	if err == nil || !Retryable(err) {
		t.Fatalf("an interrupted 2xx reply stopped saved-room recovery: %v", err)
	}
}

func TestInvalidRelayResponseBodyIsNotRetryable(t *testing.T) {
	for _, body := range []string{`{"id":`, strings.Repeat("x", 4097)} {
		t.Run(fmt.Sprint(len(body)), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusCreated)
				_, _ = fmt.Fprint(w, body)
			}))
			defer server.Close()
			_, err := CreateRoom(t.Context(), server.URL, strings.Repeat("t", 32))
			if err == nil || Retryable(err) {
				t.Fatalf("a complete but invalid reply became retryable: %v", err)
			}
		})
	}
}

func TestRelayBodyCancellationRemainsCancellation(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go func() { <-started; cancel() }()
	_, err := CreateRoom(ctx, server.URL, strings.Repeat("t", 32))
	if !errors.Is(err, context.Canceled) || Retryable(err) {
		t.Fatalf("caller cancellation was lost: %v", err)
	}
}
