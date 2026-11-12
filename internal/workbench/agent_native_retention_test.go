package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func nativeRetentionFixture(t *testing.T) (*Server, func() agentNativeItem, func(string, string, string) *httptest.ResponseRecorder) {
	t.Helper()
	s := agentTestController(t)
	const proof = "retention-window"
	s.agentNativeQueue.windows = map[string]time.Time{proof: time.Now().Add(time.Hour)}
	submit := func() agentNativeItem {
		t.Helper()
		data, err := AgentCall(context.Background(), s.configPath, "native.submit", json.RawMessage(`{"connection_id":"local","request":{"action":"chooseFolder"}}`))
		var item agentNativeItem
		if err != nil || json.Unmarshal(data, &item) != nil {
			t.Fatalf("submit: %s %v", data, err)
		}
		return item
	}
	window := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, s.origin+path, strings.NewReader(body))
		r.Header.Set("Origin", s.origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(connectionHeader, "local")
		r.Header.Set("X-Cage-Agent-Window", proof)
		r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: s.session})
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		return w
	}
	return s, submit, window
}

func TestAgentNativeReceiptRetentionStartsAtCompletion(t *testing.T) {
	for _, outcome := range []struct{ status, body string }{
		{"completed", `{"result":{"selected":"fixture"}}`},
		{"failed", `{"error":"The native operation was cancelled."}`},
	} {
		t.Run(outcome.status, func(t *testing.T) {
			s, submit, window := nativeRetentionFixture(t)
			item := submit()
			claim := window(http.MethodGet, "/api/agent/native?consumer=window", "")
			if claim.Code != http.StatusOK || !strings.Contains(claim.Body.String(), item.ID) {
				t.Fatalf("claim: %d %s", claim.Code, claim.Body.String())
			}
			// Complete an operation after 25 minutes, then model six more
			// minutes passing before another operation triggers cleanup.
			s.agentNativeQueue.mu.Lock()
			s.agentNativeQueue.items[0].created = time.Now().Add(-25 * time.Minute)
			s.agentNativeQueue.mu.Unlock()
			completePath := "/api/agent/native/" + item.ID + "/complete"
			complete := window(http.MethodPost, completePath, outcome.body)
			if complete.Code != http.StatusOK {
				t.Fatalf("complete: %d %s", complete.Code, complete.Body.String())
			}
			s.agentNativeQueue.mu.Lock()
			stored := s.agentNativeQueue.items[0]
			stored.created = time.Now().Add(-31 * time.Minute)
			if !stored.finished.IsZero() {
				stored.finished = stored.finished.Add(-6 * time.Minute)
			}
			s.agentNativeQueue.mu.Unlock()
			submit()
			response, err := AgentRequest(context.Background(), s.configPath, AgentTarget{}, http.MethodGet, "/api/agent/native/"+item.ID, nil, "", "")
			var receipt agentNativeItem
			if err != nil || json.Unmarshal(response.Data, &receipt) != nil || receipt.Status != outcome.status {
				t.Fatalf("recent completion lost its receipt: %s %v", response.Data, err)
			}
			if outcome.status == "completed" && string(receipt.Result) != `{"selected":"fixture"}` || outcome.status == "failed" && receipt.Error != "The native operation was cancelled." {
				t.Fatalf("completion changed: %s", response.Data)
			}
			// Completed receipts still expire, and duplicate acknowledgements
			// must not indefinitely extend their retention period.
			s.agentNativeQueue.mu.Lock()
			stored.finished = time.Now().Add(-31 * time.Minute)
			s.agentNativeQueue.mu.Unlock()
			if duplicate := window(http.MethodPost, completePath, outcome.body); duplicate.Code != http.StatusOK {
				t.Fatal("duplicate completion was not idempotent", duplicate.Code)
			}
			submit()
			_, err = AgentRequest(context.Background(), s.configPath, AgentTarget{}, http.MethodGet, "/api/agent/native/"+item.ID, nil, "", "")
			var failure *AgentError
			if !errors.As(err, &failure) || failure.HTTPStatus != http.StatusGone {
				t.Fatalf("expired receipt was not cleaned: %v", err)
			}
		})
	}
}

func TestAgentNativeAbandonedRunningRequestsStillExpire(t *testing.T) {
	s, submit, window := nativeRetentionFixture(t)
	for range 32 {
		item := submit()
		claim := window(http.MethodGet, "/api/agent/native?consumer=window", "")
		if claim.Code != http.StatusOK || !strings.Contains(claim.Body.String(), item.ID) {
			t.Fatalf("claim: %d %s", claim.Code, claim.Body.String())
		}
	}
	s.agentNativeQueue.mu.Lock()
	for _, item := range s.agentNativeQueue.items {
		item.created = time.Now().Add(-31 * time.Minute)
	}
	s.agentNativeQueue.mu.Unlock()
	next := submit()
	s.agentNativeQueue.mu.Lock()
	defer s.agentNativeQueue.mu.Unlock()
	if len(s.agentNativeQueue.items) != 1 || s.agentNativeQueue.items[0].ID != next.ID {
		t.Fatalf("abandoned running requests still occupy the queue: %d", len(s.agentNativeQueue.items))
	}
}
