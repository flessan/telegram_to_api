package telegram

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testToken = "123456:FAKE-TOKEN-FOR-TESTS"

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := New(testToken, srv.URL, 5*time.Second)
	c.Retries = 1
	c.RetryDelay = time.Millisecond
	return c
}

func TestGetMeSuccess(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/getMe") {
			t.Errorf("unexpected path")
		}
		w.Write([]byte(`{"ok":true,"result":{"id":1,"is_bot":true,"username":"chfless_bot"}}`))
	})
	me, err := c.GetMe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !me.IsBot || me.Username != "chfless_bot" {
		t.Fatalf("me = %+v", me)
	}
}

func TestGetMeInvalidToken(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"ok":false,"error_code":401,"description":"Unauthorized"}`))
	})
	_, err := c.GetMe(context.Background())
	if err == nil {
		t.Fatal("expected error for invalid token")
	}
	if strings.Contains(err.Error(), testToken) {
		t.Fatalf("token leaked into error: %v", err)
	}
	if !strings.Contains(err.Error(), "Unauthorized") {
		t.Fatalf("unhelpful error: %v", err)
	}
}

func TestGetUpdatesEmptyQueue(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("offset"); got != "10" {
			t.Errorf("offset = %q, want 10", got)
		}
		w.Write([]byte(`{"ok":true,"result":[]}`))
	})
	ups, err := c.GetUpdates(context.Background(), 10, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 0 {
		t.Fatalf("expected empty result")
	}
}

func TestGetUpdatesParsesChannelPost(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"result":[{"update_id":5,"channel_post":{"message_id":7,"date":1700000000,
			"chat":{"id":-1001,"type":"channel","title":"chfless","username":"chfless"},"text":"hi"}}]}`))
	})
	ups, err := c.GetUpdates(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 1 || ups[0].ChannelPost == nil || ups[0].ChannelPost.Text != "hi" {
		t.Fatalf("unexpected updates: %+v", ups)
	}
}

func TestRetriesOnServerErrorThenSucceeds(t *testing.T) {
	var calls int
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Write([]byte(`{"ok":true,"result":[]}`))
	})
	if _, err := c.GetUpdates(context.Background(), 0, 10); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("expected 2 attempts, got %d", calls)
	}
}

func TestRetriesAreBounded(t *testing.T) {
	var calls int
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
	})
	if _, err := c.GetUpdates(context.Background(), 0, 10); err == nil {
		t.Fatal("expected failure")
	}
	if calls != 2 {
		t.Fatalf("expected bounded retries (2), got %d", calls)
	}
}

func TestMalformedJSONIsRejected(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`<html>not json</html>`))
	})
	if _, err := c.GetUpdates(context.Background(), 0, 10); err == nil {
		t.Fatal("expected decode error")
	}
}
