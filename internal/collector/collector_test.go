package collector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/flessan/telegram_to_api/internal/storage"
	"github.com/flessan/telegram_to_api/internal/telegram"
)

const channelID = int64(-1001234567890)

// fakeAPI serves canned responses; no network, no credentials involved.
type fakeAPI struct {
	me      telegram.User
	meErr   error
	batches [][]telegram.Update
	err     error
	calls   int
	offsets []int64
}

func (f *fakeAPI) GetMe(context.Context) (telegram.User, error) { return f.me, f.meErr }

func (f *fakeAPI) GetUpdates(_ context.Context, offset int64, _ int) ([]telegram.Update, error) {
	f.offsets = append(f.offsets, offset)
	if f.err != nil {
		return nil, f.err
	}
	i := f.calls
	f.calls++
	if i < len(f.batches) {
		return f.batches[i], nil
	}
	return nil, nil
}

func newAPI(batches ...[]telegram.Update) *fakeAPI {
	return &fakeAPI{me: telegram.User{IsBot: true, Username: "chfless_bot"}, batches: batches}
}

func post(updateID, messageID int64, date int64, text string) telegram.Update {
	return telegram.Update{
		UpdateID: updateID,
		ChannelPost: &telegram.Message{
			MessageID: messageID,
			Date:      date,
			Chat:      telegram.Chat{ID: channelID, Type: "channel", Title: "chfless", Username: "chfless"},
			Text:      text,
		},
	}
}

func photoPost(updateID, messageID int64) telegram.Update {
	u := post(updateID, messageID, 1700000100, "")
	u.ChannelPost.Caption = "photo caption"
	u.ChannelPost.Photo = []telegram.PhotoSize{{FileID: "big", FileUniqueID: "ub", Width: 1000, Height: 500}}
	return u
}

func opts(dir string) Options {
	return Options{
		ChannelID: channelID,
		FeedPath:  filepath.Join(dir, "posts.json"),
		StatePath: filepath.Join(dir, "state.json"),
		PostLimit: 20,
		Verify:    true,
		Now:       func() time.Time { return time.Unix(1700000500, 0) },
	}
}

func readFeed(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "posts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("generated feed is not valid JSON: %v", err)
	}
	return m
}

func TestRunWritesTextAndPhotoPosts(t *testing.T) {
	dir := t.TempDir()
	a := newAPI([]telegram.Update{post(1, 10, 1700000000, "hello"), photoPost(2, 11)})

	res, err := Run(context.Background(), a, opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Changed || res.RelevantPosts != 2 || res.LastUpdateID != 2 {
		t.Fatalf("result = %+v", res)
	}

	feed := readFeed(t, dir)
	posts := feed["posts"].([]any)
	if len(posts) != 2 {
		t.Fatalf("expected 2 posts, got %d", len(posts))
	}
	first := posts[0].(map[string]any)
	if first["type"] != "text" || first["text"] != "hello" || first["url"] != "https://t.me/chfless/10" {
		t.Fatalf("text post wrong: %+v", first)
	}
	second := posts[1].(map[string]any)
	if second["type"] != "photo" || second["text"] != "photo caption" {
		t.Fatalf("photo post wrong: %+v", second)
	}
	if feed["latest"].(map[string]any)["id"].(float64) != 11 {
		t.Fatalf("latest wrong: %+v", feed["latest"])
	}
	ch := feed["channel"].(map[string]any)
	if ch["username"] != "chfless" || ch["url"] != "https://t.me/chfless" {
		t.Fatalf("channel metadata wrong: %+v", ch)
	}

	st, _ := storage.LoadState(filepath.Join(dir, "state.json"))
	if st.LastUpdateID != 2 {
		t.Fatalf("state = %+v", st)
	}
}

func TestRunOffsetAdvancesAcrossRuns(t *testing.T) {
	dir := t.TempDir()
	a := newAPI(
		[]telegram.Update{post(7, 10, 1700000000, "one")},
		[]telegram.Update{post(8, 11, 1700000100, "two")},
	)
	if _, err := Run(context.Background(), a, opts(dir)); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(context.Background(), a, opts(dir)); err != nil {
		t.Fatal(err)
	}
	if got := a.offsets; len(got) != 2 || got[0] != 0 || got[1] != 8 {
		t.Fatalf("offsets = %v, want [0 8]", got)
	}
	if len(readFeed(t, dir)["posts"].([]any)) != 2 {
		t.Fatalf("expected both posts retained")
	}
}

func TestRunIsIdempotentForDuplicateUpdates(t *testing.T) {
	dir := t.TempDir()
	batch := []telegram.Update{post(1, 10, 1700000000, "hello")}
	a := newAPI(batch, batch) // Telegram redelivering the same update

	if _, err := Run(context.Background(), a, opts(dir)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "posts.json"))

	res, err := Run(context.Background(), a, opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "posts.json"))

	if res.Changed {
		t.Fatalf("duplicate update should not change the feed")
	}
	if string(before) != string(after) {
		t.Fatalf("feed changed on duplicate run")
	}
}

func TestRunEmptyQueueDoesNotTouchFeed(t *testing.T) {
	dir := t.TempDir()
	a := newAPI([]telegram.Update{post(1, 10, 1700000000, "hello")}, nil)
	if _, err := Run(context.Background(), a, opts(dir)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "posts.json"))
	statBefore, _ := os.Stat(filepath.Join(dir, "posts.json"))

	res, err := Run(context.Background(), a, opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed {
		t.Fatalf("empty queue must not change the feed")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "posts.json"))
	statAfter, _ := os.Stat(filepath.Join(dir, "posts.json"))
	if string(before) != string(after) || !statBefore.ModTime().Equal(statAfter.ModTime()) {
		t.Fatalf("feed file was rewritten unnecessarily")
	}
}

func TestRunIgnoresOtherChannelsAndUnsupportedUpdates(t *testing.T) {
	dir := t.TempDir()
	foreign := post(1, 10, 1700000000, "not mine")
	foreign.ChannelPost.Chat.ID = -100999
	foreign.ChannelPost.Chat.Username = "chfless" // username spoofing must not help

	group := post(2, 11, 1700000000, "group")
	group.ChannelPost.Chat.Type = "supergroup"

	malformed := telegram.Update{UpdateID: 3} // no channel_post at all
	valid := post(4, 12, 1700000200, "mine")

	a := newAPI([]telegram.Update{foreign, group, malformed, valid})
	res, err := Run(context.Background(), a, opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	if res.RelevantPosts != 1 {
		t.Fatalf("relevant posts = %d, want 1", res.RelevantPosts)
	}
	if res.LastUpdateID != 4 {
		t.Fatalf("offset must advance past ignored updates, got %d", res.LastUpdateID)
	}
	posts := readFeed(t, dir)["posts"].([]any)
	if len(posts) != 1 || posts[0].(map[string]any)["text"] != "mine" {
		t.Fatalf("posts = %+v", posts)
	}
}

func TestRunRetentionLimit(t *testing.T) {
	dir := t.TempDir()
	var ups []telegram.Update
	for i := int64(1); i <= 5; i++ {
		ups = append(ups, post(i, i, 1700000000+i, "p"))
	}
	o := opts(dir)
	o.PostLimit = 3
	if _, err := Run(context.Background(), &fakeAPI{me: telegram.User{IsBot: true}, batches: [][]telegram.Update{ups}}, o); err != nil {
		t.Fatal(err)
	}
	posts := readFeed(t, dir)["posts"].([]any)
	if len(posts) != 3 || posts[0].(map[string]any)["id"].(float64) != 3 {
		t.Fatalf("retention failed: %+v", posts)
	}
}

func TestRunFailsCleanlyOnInvalidToken(t *testing.T) {
	dir := t.TempDir()
	a := newAPI()
	a.meErr = &telegram.APIError{Method: "getMe", Code: 401, Description: "Unauthorized"}

	if _, err := Run(context.Background(), a, opts(dir)); err == nil {
		t.Fatal("expected error")
	}
	if _, err := os.Stat(filepath.Join(dir, "posts.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("no files must be written when auth fails")
	}
}

func TestRunPreservesExistingDataWhenApiFails(t *testing.T) {
	dir := t.TempDir()
	a := newAPI([]telegram.Update{post(1, 10, 1700000000, "hello")})
	if _, err := Run(context.Background(), a, opts(dir)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "posts.json"))

	broken := newAPI()
	broken.err = errors.New("network unreachable")
	if _, err := Run(context.Background(), broken, opts(dir)); err == nil {
		t.Fatal("expected error")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "posts.json"))
	if string(before) != string(after) {
		t.Fatalf("existing feed must be preserved when a run fails")
	}
	if !json.Valid(after) {
		t.Fatalf("feed left in invalid state")
	}
}

func TestRunEditedPostUpdatesExisting(t *testing.T) {
	dir := t.TempDir()
	orig := post(1, 10, 1700000000, "typo")
	edited := telegram.Update{UpdateID: 2, EditedChannelPost: &telegram.Message{
		MessageID: 10, Date: 1700000000, EditDate: 1700000300,
		Chat: telegram.Chat{ID: channelID, Type: "channel", Title: "chfless", Username: "chfless"},
		Text: "fixed",
	}}
	a := newAPI([]telegram.Update{orig, edited})
	if _, err := Run(context.Background(), a, opts(dir)); err != nil {
		t.Fatal(err)
	}
	posts := readFeed(t, dir)["posts"].([]any)
	if len(posts) != 1 || posts[0].(map[string]any)["text"] != "fixed" {
		t.Fatalf("edit not applied: %+v", posts)
	}
	if posts[0].(map[string]any)["edited_at"] != "2023-11-14T22:18:20Z" {
		t.Fatalf("edited_at missing: %+v", posts[0])
	}
}
