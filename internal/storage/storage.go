// Package storage reads and writes the two generated files:
//
//	data/posts.json  – the public feed consumed by the website
//	data/state.json  – the collector's last processed Telegram update_id
//
// Both are written atomically (temp file + rename) so a crashed or cancelled
// run can never leave a truncated / invalid JSON file behind.
package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/flessan/telegram_to_api/internal/normalize"
)

// State is the tiny persisted cursor. It contains no secrets.
type State struct {
	// LastUpdateID is the highest Telegram update_id that has been fully
	// processed and committed. The next run asks for LastUpdateID+1, which
	// also acknowledges (and frees) the previous updates server-side.
	LastUpdateID int64 `json:"last_update_id"`
}

// LoadFeed reads an existing feed. A missing file yields an empty feed.
// A corrupt file is reported as an error so a run fails loudly instead of
// silently discarding previously collected posts.
func LoadFeed(path string) (normalize.Feed, error) {
	var feed normalize.Feed
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return normalize.Feed{Version: normalize.SchemaVersion, Posts: []normalize.Post{}}, nil
	}
	if err != nil {
		return feed, fmt.Errorf("read feed: %w", err)
	}
	if err := json.Unmarshal(b, &feed); err != nil {
		return feed, fmt.Errorf("existing feed %s is not valid JSON: %w", path, err)
	}
	if feed.Posts == nil {
		feed.Posts = []normalize.Post{}
	}
	return feed, nil
}

// LoadState reads the offset cursor. A missing or unreadable file simply means
// "start from the beginning of whatever Telegram still has queued".
func LoadState(path string) (State, error) {
	var s State
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return s, fmt.Errorf("read state: %w", err)
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return State{}, fmt.Errorf("existing state %s is not valid JSON: %w", path, err)
	}
	return s, nil
}

// SaveFeed writes the feed deterministically (2-space indent, trailing newline).
func SaveFeed(path string, feed normalize.Feed) error {
	return writeJSON(path, feed)
}

// SaveState writes the cursor.
func SaveState(path string, s State) error {
	return writeJSON(path, s)
}

// Marshal renders a value the same way SaveFeed writes it to disk.
func Marshal(v any) ([]byte, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func writeJSON(path string, v any) error {
	b, err := Marshal(v)
	if err != nil {
		return fmt.Errorf("encode %s: %w", filepath.Base(path), err)
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeded

	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}
