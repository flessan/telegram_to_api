package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/flessan/telegram_to_api/internal/normalize"
)

func TestLoadMissingFilesReturnsEmptyDefaults(t *testing.T) {
	dir := t.TempDir()
	feed, err := LoadFeed(filepath.Join(dir, "posts.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(feed.Posts) != 0 {
		t.Fatalf("expected no posts")
	}
	st, err := LoadState(filepath.Join(dir, "state.json"))
	if err != nil || st.LastUpdateID != 0 {
		t.Fatalf("state = %+v err = %v", st, err)
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "posts.json")

	feed := normalize.BuildFeed(
		normalize.Channel{ID: -100, Username: "chfless", URL: "https://t.me/chfless"},
		[]normalize.Post{{ID: 1, Type: "text", Text: "hi", PublishedAt: "2023-11-14T22:13:20Z", URL: "https://t.me/chfless/1"}},
		time.Unix(1700000000, 0),
	)
	if err := SaveFeed(path, feed); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(raw) {
		t.Fatalf("generated file is not valid JSON")
	}
	if raw[len(raw)-1] != '\n' {
		t.Fatalf("file must end with a newline")
	}

	back, err := LoadFeed(path)
	if err != nil {
		t.Fatal(err)
	}
	if back.Latest == nil || back.Latest.ID != 1 || back.Channel.Username != "chfless" {
		t.Fatalf("round trip mismatch: %+v", back)
	}
}

func TestSaveIsDeterministic(t *testing.T) {
	dir := t.TempDir()
	feed := normalize.BuildFeed(normalize.Channel{ID: -100}, []normalize.Post{{ID: 2}}, time.Unix(1700000000, 0))

	p1 := filepath.Join(dir, "a.json")
	p2 := filepath.Join(dir, "b.json")
	if err := SaveFeed(p1, feed); err != nil {
		t.Fatal(err)
	}
	if err := SaveFeed(p2, feed); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(p1)
	b, _ := os.ReadFile(p2)
	if string(a) != string(b) {
		t.Fatalf("output is not deterministic")
	}
}

func TestStateSerialization(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := SaveState(path, State{LastUpdateID: 42}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "{\n  \"last_update_id\": 42\n}\n" {
		t.Fatalf("unexpected state file: %q", raw)
	}
	st, err := LoadState(path)
	if err != nil || st.LastUpdateID != 42 {
		t.Fatalf("state = %+v err = %v", st, err)
	}
}

func TestCorruptFeedIsReported(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "posts.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFeed(path); err == nil {
		t.Fatalf("expected an error for corrupt feed")
	}
}

func TestWriteLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	if err := SaveState(filepath.Join(dir, "state.json"), State{LastUpdateID: 1}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected exactly one file, got %d", len(entries))
	}
}
