// Package collector wires the Telegram client, the normalizer and the storage
// layer into a single idempotent run.
package collector

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/flessan/telegram_to_api/internal/normalize"
	"github.com/flessan/telegram_to_api/internal/storage"
	"github.com/flessan/telegram_to_api/internal/telegram"
)

// API is the subset of the Telegram client the collector depends on. It exists
// so tests can inject a fake without any network access.
type API interface {
	GetMe(ctx context.Context) (telegram.User, error)
	GetUpdates(ctx context.Context, offset int64, limit int) ([]telegram.Update, error)
}

// Options configures a single collector run.
type Options struct {
	ChannelID   int64
	FeedPath    string
	StatePath   string
	PostLimit   int
	UpdateLimit int
	Now         func() time.Time
	Verify      bool
}

// Result summarises what a run did (used for logging and tests).
type Result struct {
	FetchedUpdates int
	RelevantPosts  int
	Changed        bool
	LastUpdateID   int64
}

// Run executes one collection cycle:
//
//  1. verify the token with getMe (optional),
//  2. load the previous feed and offset,
//  3. fetch updates from the stored offset,
//  4. normalize only channel posts of the configured channel,
//  5. merge + retain, then write the feed atomically,
//  6. only then persist the new offset.
//
// If any step before the feed write fails, the existing files stay untouched.
// If the feed write succeeds but the state write fails, the next run re-reads
// the same updates and merging deduplicates them — no posts are lost or dupli-
// cated. That ordering makes the whole run safely retryable.
func Run(ctx context.Context, api API, opt Options) (Result, error) {
	var res Result

	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.PostLimit <= 0 {
		opt.PostLimit = 20
	}
	if opt.UpdateLimit <= 0 {
		opt.UpdateLimit = 100
	}

	if opt.Verify {
		me, err := api.GetMe(ctx)
		if err != nil {
			return res, fmt.Errorf("token verification failed: %w", err)
		}
		if !me.IsBot {
			return res, fmt.Errorf("token verification failed: credentials do not belong to a bot")
		}
		log.Printf("authenticated as bot @%s", me.Username)
	}

	feed, err := storage.LoadFeed(opt.FeedPath)
	if err != nil {
		return res, err
	}
	state, err := storage.LoadState(opt.StatePath)
	if err != nil {
		return res, err
	}

	offset := int64(0)
	if state.LastUpdateID > 0 {
		offset = state.LastUpdateID + 1
	}

	updates, err := api.GetUpdates(ctx, offset, opt.UpdateLimit)
	if err != nil {
		return res, err
	}
	res.FetchedUpdates = len(updates)
	res.LastUpdateID = state.LastUpdateID

	channel := feed.Channel
	var incoming []normalize.Post
	highest := state.LastUpdateID

	for _, u := range updates {
		if u.UpdateID > highest {
			highest = u.UpdateID
		}
		msg := u.ChannelPost
		if msg == nil {
			msg = u.EditedChannelPost
		}
		if msg == nil {
			continue // unsupported update type: acknowledged, ignored
		}
		if msg.Chat.Type != "channel" || msg.Chat.ID != opt.ChannelID {
			// Identity is decided by the numeric chat ID only, never by username.
			continue
		}
		if msg.MessageID <= 0 {
			continue // malformed update
		}
		channel = normalize.ChannelFromMessage(msg)
		incoming = append(incoming, normalize.Message(msg))
	}
	res.RelevantPosts = len(incoming)

	if channel.ID == 0 {
		channel.ID = opt.ChannelID
	}

	posts := normalize.Merge(feed.Posts, incoming, opt.PostLimit)
	next := normalize.BuildFeed(channel, posts, opt.Now())

	// Determine whether anything meaningful changed, ignoring updated_at so
	// that idle runs never produce a pointless commit.
	changed, err := feedContentChanged(feed, next)
	if err != nil {
		return res, err
	}
	res.Changed = changed

	if changed {
		if err := storage.SaveFeed(opt.FeedPath, next); err != nil {
			return res, err
		}
	}

	if highest != state.LastUpdateID {
		if err := storage.SaveState(opt.StatePath, storage.State{LastUpdateID: highest}); err != nil {
			return res, err
		}
		res.LastUpdateID = highest
	}

	return res, nil
}

// feedContentChanged compares everything except updated_at.
func feedContentChanged(old, next normalize.Feed) (bool, error) {
	a := old
	b := next
	a.UpdatedAt = ""
	b.UpdatedAt = ""
	ab, err := storage.Marshal(a)
	if err != nil {
		return false, err
	}
	bb, err := storage.Marshal(b)
	if err != nil {
		return false, err
	}
	return string(ab) != string(bb), nil
}
