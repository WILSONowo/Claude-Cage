package mobilelink_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sylvinus/agent-vm/internal/mobilelink"
	"github.com/sylvinus/agent-vm/internal/mobilelink/nativeclient"
	"github.com/sylvinus/agent-vm/internal/remotelink"
	"golang.org/x/net/http2"
)

func TestSavedClientRenewsCertificateWhenReconnecting(t *testing.T) {
	f := newFixture(t)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	d := device{key}
	pin, err := nativeclient.Fingerprint(d)
	if err != nil {
		t.Fatal(err)
	}
	lookup := strings.Repeat("A", 43)
	certificates := make(chan *x509.Certificate, 2)
	startHost := func() func() {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		t.Cleanup(cancel)
		room, err := mobilelink.CreateDiscoverableRoom(ctx, f.base, strings.Repeat("t", 64), lookup)
		for err != nil && mobilelink.Retryable(err) && ctx.Err() == nil {
			time.Sleep(10 * time.Millisecond)
			room, err = mobilelink.CreateDiscoverableRoom(ctx, f.base, strings.Repeat("t", 64), lookup)
		}
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			ws, _, err := websocket.DefaultDialer.DialContext(ctx,
				"ws"+strings.TrimPrefix(f.base, "http")+"/v1/rooms/"+room.ID+"/host",
				http.Header{"Authorization": {"Bearer " + room.HostToken}})
			if err != nil {
				t.Error(err)
				return
			}
			conn, err := remotelink.ServerAfterJoin(ctx, ws, f.identity, pin)
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.NetConn().Close()
			stop := context.AfterFunc(ctx, func() { _ = conn.NetConn().Close() })
			defer stop()
			certificates <- conn.ConnectionState().PeerCertificates[0]
			server := &http2.Server{}
			server.ServeConn(conn, &http2.ServeConnOpts{Context: ctx, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"projects":[]}`))
			})})
		}()
		return func() { cancel(); <-done }
	}
	stop := startHost()
	client, err := nativeclient.OpenSaved(f.base, lookup, f.identity.Pin, d)
	if err != nil {
		stop()
		t.Fatal(err)
	}
	defer client.Close()
	first := <-certificates
	stop()
	stop = startHost()
	defer stop()
	if _, err := client.Request(http.MethodGet, "/api/mobile/cli/projects", nil); err != nil {
		t.Fatal(err)
	}
	second := <-certificates
	if bytes.Equal(first.Raw, second.Raw) {
		t.Fatal("reconnected using the original short-lived certificate; a client open for over 24 hours cannot recover")
	}
	if !bytes.Equal(first.RawSubjectPublicKeyInfo, second.RawSubjectPublicKeyInfo) {
		t.Fatal("certificate renewal changed the paired device identity")
	}
}
