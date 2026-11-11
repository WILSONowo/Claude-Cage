package workbench

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/sylvinus/agent-vm/internal/mobilelink"
)

func TestPhoneSurfaceGuestConflictHTTP(t *testing.T) {
	const id = "d4bd9946-fdc4-408a-9a79-219cbe3df2a7"
	for _, tc := range []struct {
		name        string
		surface     phoneSurface
		op          string
		guestStatus int
		returnFrame bool
		want        int
		message     string
	}{
		{"browser frame", phoneBrowser, "frame", 409, false, 425, "正在等待网页完成切换"},
		{"browser input", phoneBrowser, "action", 409, false, 409, "画面或焦点已变化"},
		{"browser input with frame", phoneBrowser, "action", 409, true, 409, "画面或焦点已变化"},
		{"browser open", phoneBrowser, "open", 409, false, 409, "画面或焦点已变化"},
		{"desktop frame", phoneDesktop, "frame", 409, false, 425, "正在等待 Claude Desktop 窗口"},
		{"desktop input", phoneDesktop, "action", 409, false, 409, "画面或焦点已变化"},
		{"guest authorization", phoneBrowser, "frame", 403, false, 403, "客机拒绝此次访问"},
		{"expired session", phoneBrowser, "frame", 410, false, 410, "会话已结束"},
		{"missing component", phoneBrowser, "frame", 404, false, 409, "当前客机未提供"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPost || r.URL.Path != "/phone-"+string(tc.surface)+"/"+tc.op || r.Header.Get("Authorization") != "Bearer guest-token" {
					t.Errorf("unexpected guest request: %s %s", r.Method, r.URL.Path)
				}
				var input phoneSurfaceInput
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.ID != id || input.ReturnFrame != tc.returnFrame {
					t.Errorf("guest request changed: %+v, %v", input, err)
				}
				http.Error(w, "guest conflict", tc.guestStatus)
			}))
			defer guest.Close()
			s := &Server{}
			s.browserControl = localBrowserClient(t, context.Background(), guest)
			input := phoneSurfaceInput{ID: id, Type: "text", Document: "before-navigation", Focus: "input", Text: "send once", ReturnFrame: tc.returnFrame}
			_, status, err := s.phoneSurfaceGuest(context.Background(), tc.surface, "guest-token", tc.op, input)
			if err != nil || status != tc.guestStatus {
				t.Fatalf("guest response: status=%d, err=%v", status, err)
			}
			w := httptest.NewRecorder()
			s.writePhoneSurfaceFailure(w, tc.surface, tc.op, status, err)
			if w.Code != tc.want || !strings.Contains(w.Body.String(), tc.message) {
				t.Fatalf("phone response: %d %s; want %d containing %q", w.Code, w.Body.String(), tc.want, tc.message)
			}
			if calls.Load() != 1 {
				t.Fatalf("guest operation was repeated %d times", calls.Load())
			}
		})
	}
}

// A host authorization failure also uses HTTP 409, but is not a guest frame
// conflict. Exercise the actual request handler to keep that failure terminal.
func TestPhoneBrowserFrameNetworkConflictIsNotRetryable(t *testing.T) {
	for _, paused := range []bool{false, true} {
		t.Run(map[bool]string{false: "not ready", true: "network paused"}[paused], func(t *testing.T) {
			const id = "d4bd9946-fdc4-408a-9a79-219cbe3df2a7"
			var closes atomic.Int32
			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/phone-browser/close" {
					t.Errorf("blocked request reached guest: %s", r.URL.Path)
				}
				closes.Add(1)
				_, _ = io.WriteString(w, `{}`)
			}))
			defer guest.Close()
			s := &Server{ready: paused, networkPaused: paused}
			s.browserControl = localBrowserClient(t, context.Background(), guest)
			room, cancelRoom := context.WithCancel(context.Background())
			defer cancelRoom()
			epoch, cancelEpoch := context.WithCancel(context.Background())
			defer cancelEpoch()
			session, cancelSession := context.WithCancel(room)
			defer cancelSession()
			s.phones.roomCtx = room
			s.phones.roomProof = "paired-room-proof"
			s.phones.browser.session = &phoneSurfaceSession{
				id: id, token: "guest-token", ctx: session, cancel: cancelSession,
				stopEpoch: context.AfterFunc(epoch, cancelSession),
			}
			r := httptest.NewRequest(http.MethodGet, "http://phone/api/mobile/browser/"+id+"/frame", nil)
			r.SetPathValue("id", id)
			r.Header.Set(mobilelink.PhoneRoomHeader, s.phones.roomProof)
			r = r.WithContext(context.WithValue(r.Context(), mobileEpochKey{}, epoch))
			w := httptest.NewRecorder()
			s.phoneSurfaceRequest(phoneBrowser, w, r)
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "确保网络检查已放行") {
				t.Fatalf("host network failure became retryable: %d %s", w.Code, w.Body.String())
			}
			if s.phones.browser.session != nil || session.Err() == nil || closes.Load() != 1 {
				t.Fatal("blocked phone session was not retired")
			}
		})
	}
}
