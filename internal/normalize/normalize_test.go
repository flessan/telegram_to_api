package normalize

import (
	"testing"
	"time"

	"github.com/flessan/telegram_to_api/internal/telegram"
)

func textMessage() *telegram.Message {
	return &telegram.Message{
		MessageID: 12,
		Date:      1700000000,
		Chat:      telegram.Chat{ID: -1001234567890, Type: "channel", Title: "chfless", Username: "chfless"},
		Text:      "hello world",
	}
}

func photoMessage() *telegram.Message {
	return &telegram.Message{
		MessageID: 13,
		Date:      1700000100,
		Chat:      telegram.Chat{ID: -1001234567890, Type: "channel", Title: "chfless", Username: "chfless"},
		Caption:   "a caption",
		Photo: []telegram.PhotoSize{
			{FileID: "small", FileUniqueID: "us", Width: 90, Height: 60},
			{FileID: "big", FileUniqueID: "ub", Width: 1280, Height: 853},
		},
	}
}

func TestMessageTextPost(t *testing.T) {
	p := Message(textMessage())
	if p.Type != TypeText {
		t.Fatalf("type = %q, want text", p.Type)
	}
	if p.Text != "hello world" {
		t.Fatalf("text = %q", p.Text)
	}
	if p.URL != "https://t.me/chfless/12" {
		t.Fatalf("url = %q", p.URL)
	}
	if p.PublishedAt != "2023-11-14T22:13:20Z" {
		t.Fatalf("published_at = %q", p.PublishedAt)
	}
	if p.Media != nil {
		t.Fatalf("text post must not carry media")
	}
}

func TestMessagePhotoPostUsesCaptionAndLargestSize(t *testing.T) {
	p := Message(photoMessage())
	if p.Type != TypePhoto {
		t.Fatalf("type = %q, want photo", p.Type)
	}
	if p.Text != "a caption" {
		t.Fatalf("caption not normalized into text: %q", p.Text)
	}
	if p.Media == nil || p.Media.FileID != "big" || p.Media.Width != 1280 || p.Media.Height != 853 {
		t.Fatalf("media = %+v", p.Media)
	}
}

func TestMessageWithoutTextIsEmptyString(t *testing.T) {
	m := photoMessage()
	m.Caption = ""
	p := Message(m)
	if p.Text != "" {
		t.Fatalf("expected empty text, got %q", p.Text)
	}
}

func TestClassifyUnsupportedMedia(t *testing.T) {
	m := &telegram.Message{MessageID: 1, Chat: telegram.Chat{Type: "channel"}}
	kind, media := Classify(m)
	if kind != TypeOther || media != nil {
		t.Fatalf("kind=%q media=%+v", kind, media)
	}

	m.Video = &telegram.Video{FileID: "v", FileUniqueID: "uv", Width: 10, Height: 20}
	if kind, media = Classify(m); kind != TypeVideo || media.FileID != "v" {
		t.Fatalf("video classification failed: %q %+v", kind, media)
	}

	m.Video = nil
	m.Document = &telegram.Document{FileID: "d", FileUniqueID: "ud"}
	if kind, _ = Classify(m); kind != TypeFile {
		t.Fatalf("document classification failed: %q", kind)
	}
}

func TestMessageURLPrivateChannelHasNoLink(t *testing.T) {
	if got := MessageURL("", 5); got != "" {
		t.Fatalf("expected empty url, got %q", got)
	}
	if got := ChannelURL(""); got != "" {
		t.Fatalf("expected empty channel url, got %q", got)
	}
	if got := ChannelURL("chfless"); got != "https://t.me/chfless" {
		t.Fatalf("channel url = %q", got)
	}
}

func TestMergeDeduplicatesAndOrders(t *testing.T) {
	a := Message(textMessage())
	b := Message(photoMessage())

	merged := Merge([]Post{b}, []Post{a, b, a}, 20)
	if len(merged) != 2 {
		t.Fatalf("expected 2 unique posts, got %d", len(merged))
	}
	if merged[0].ID != 12 || merged[1].ID != 13 {
		t.Fatalf("wrong chronological order: %d, %d", merged[0].ID, merged[1].ID)
	}
}

func TestMergeIsIdempotent(t *testing.T) {
	posts := []Post{Message(textMessage()), Message(photoMessage())}
	once := Merge(nil, posts, 20)
	twice := Merge(once, posts, 20)
	if len(once) != len(twice) {
		t.Fatalf("merge not idempotent: %d vs %d", len(once), len(twice))
	}
}

func TestMergeEditReplacesPost(t *testing.T) {
	orig := Message(textMessage())
	edited := orig
	edited.Text = "edited"
	merged := Merge([]Post{orig}, []Post{edited}, 20)
	if len(merged) != 1 || merged[0].Text != "edited" {
		t.Fatalf("edit not applied: %+v", merged)
	}
}

func TestMergeRetentionKeepsNewest(t *testing.T) {
	var posts []Post
	for i := 1; i <= 5; i++ {
		posts = append(posts, Post{ID: int64(i), PublishedAt: time.Unix(int64(1700000000+i), 0).UTC().Format(time.RFC3339)})
	}
	merged := Merge(nil, posts, 3)
	if len(merged) != 3 || merged[0].ID != 3 || merged[2].ID != 5 {
		t.Fatalf("retention wrong: %+v", merged)
	}
}

func TestBuildFeedLatestPointsToNewest(t *testing.T) {
	posts := Merge(nil, []Post{Message(textMessage()), Message(photoMessage())}, 20)
	feed := BuildFeed(Channel{ID: -1001234567890, Username: "chfless", URL: "https://t.me/chfless"}, posts, time.Unix(1700000200, 0))
	if feed.Version != SchemaVersion {
		t.Fatalf("version = %d", feed.Version)
	}
	if feed.Latest == nil || feed.Latest.ID != 13 {
		t.Fatalf("latest = %+v", feed.Latest)
	}
	if feed.UpdatedAt != "2023-11-14T22:16:40Z" {
		t.Fatalf("updated_at = %q", feed.UpdatedAt)
	}
}

func TestBuildFeedEmpty(t *testing.T) {
	feed := BuildFeed(Channel{}, nil, time.Unix(0, 0))
	if feed.Latest != nil {
		t.Fatalf("empty feed must have null latest")
	}
	if feed.Posts == nil {
		t.Fatalf("posts must serialize as [] not null")
	}
}
