// Package normalize converts raw Telegram Bot API updates into the compact,
// stable JSON schema that the public website consumes.
//
// Nothing Telegram-specific and sensitive (tokens, request URLs, internal
// user objects) ever reaches these structures.
package normalize

import (
	"fmt"
	"sort"
	"time"

	"github.com/flessan/telegram_to_api/internal/telegram"
)

// SchemaVersion is bumped whenever the public JSON shape changes incompatibly.
const SchemaVersion = 1

// Post types emitted in the feed.
const (
	TypeText  = "text"
	TypePhoto = "photo"
	TypeVideo = "video"
	TypeFile  = "document"
	TypeOther = "other"
)

// Channel is the public channel metadata block.
type Channel struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	Username string `json:"username"`
	URL      string `json:"url"`
}

// Media describes non-sensitive attributes of an attached file.
//
// file_id is retained because it is the only way for the owner's own website /
// tooling to later resolve a download link via getFile. It is not a secret and
// is useless without the bot token.
type Media struct {
	Type     string `json:"type"`
	FileID   string `json:"file_id"`
	UniqueID string `json:"unique_id"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
}

// Post is a single normalized channel post.
type Post struct {
	ID          int64  `json:"id"`
	Type        string `json:"type"`
	Text        string `json:"text"`
	PublishedAt string `json:"published_at"`
	EditedAt    string `json:"edited_at,omitempty"`
	URL         string `json:"url"`
	Media       *Media `json:"media,omitempty"`
}

// Feed is the root document written to data/posts.json.
type Feed struct {
	Version   int     `json:"version"`
	Channel   Channel `json:"channel"`
	UpdatedAt string  `json:"updated_at"`
	Latest    *Post   `json:"latest"`
	Posts     []Post  `json:"posts"`
}

// ChannelFromMessage derives public channel metadata from a channel post.
func ChannelFromMessage(m *telegram.Message) Channel {
	c := Channel{ID: m.Chat.ID, Title: m.Chat.Title, Username: m.Chat.Username}
	c.URL = ChannelURL(c.Username)
	return c
}

// ChannelURL builds the public channel URL, empty for private channels.
func ChannelURL(username string) string {
	if username == "" {
		return ""
	}
	return "https://t.me/" + username
}

// MessageURL builds a direct public message link. Private channels (no
// username) have no stable public link, so an empty string is returned.
func MessageURL(username string, messageID int64) string {
	if username == "" {
		return ""
	}
	return fmt.Sprintf("https://t.me/%s/%d", username, messageID)
}

// Text extracts the human readable body of a post: message text for text
// posts, caption for media posts, and "" when neither exists.
func Text(m *telegram.Message) string {
	if m.Text != "" {
		return m.Text
	}
	return m.Caption
}

// Classify determines the post type and the associated media, if any.
func Classify(m *telegram.Message) (string, *Media) {
	switch {
	case len(m.Photo) > 0:
		// Telegram returns ascending renditions; the last one is the largest.
		best := m.Photo[0]
		for _, p := range m.Photo {
			if p.Width*p.Height > best.Width*best.Height {
				best = p
			}
		}
		return TypePhoto, &Media{
			Type:     TypePhoto,
			FileID:   best.FileID,
			UniqueID: best.FileUniqueID,
			Width:    best.Width,
			Height:   best.Height,
		}
	case m.Video != nil:
		return TypeVideo, &Media{
			Type:     TypeVideo,
			FileID:   m.Video.FileID,
			UniqueID: m.Video.FileUniqueID,
			Width:    m.Video.Width,
			Height:   m.Video.Height,
		}
	case m.Document != nil:
		return TypeFile, &Media{
			Type:     TypeFile,
			FileID:   m.Document.FileID,
			UniqueID: m.Document.FileUniqueID,
		}
	case m.Text != "":
		return TypeText, nil
	default:
		return TypeOther, nil
	}
}

// Message converts a single channel post into a Post.
func Message(m *telegram.Message) Post {
	kind, media := Classify(m)
	p := Post{
		ID:          m.MessageID,
		Type:        kind,
		Text:        Text(m),
		PublishedAt: rfc3339(m.Date),
		URL:         MessageURL(m.Chat.Username, m.MessageID),
		Media:       media,
	}
	if m.EditDate > 0 {
		p.EditedAt = rfc3339(m.EditDate)
	}
	return p
}

func rfc3339(unix int64) string {
	if unix <= 0 {
		return ""
	}
	return time.Unix(unix, 0).UTC().Format(time.RFC3339)
}

// Merge combines existing posts with new ones, deduplicating by message ID
// (posts of a feed always belong to a single, already-filtered channel),
// sorting chronologically and retaining at most limit posts.
//
// Newer versions of the same message ID (edits) replace older ones.
func Merge(existing, incoming []Post, limit int) []Post {
	byID := make(map[int64]Post, len(existing)+len(incoming))
	order := make([]int64, 0, len(existing)+len(incoming))
	for _, p := range append(append([]Post{}, existing...), incoming...) {
		if _, ok := byID[p.ID]; !ok {
			order = append(order, p.ID)
		}
		byID[p.ID] = p
	}

	merged := make([]Post, 0, len(order))
	for _, id := range order {
		merged = append(merged, byID[id])
	}

	sort.SliceStable(merged, func(i, j int) bool {
		if merged[i].PublishedAt == merged[j].PublishedAt {
			return merged[i].ID < merged[j].ID
		}
		return merged[i].PublishedAt < merged[j].PublishedAt
	})

	if limit > 0 && len(merged) > limit {
		merged = merged[len(merged)-limit:]
	}
	return merged
}

// BuildFeed assembles the final document. updatedAt is injected so that output
// stays deterministic in tests.
func BuildFeed(channel Channel, posts []Post, updatedAt time.Time) Feed {
	if posts == nil {
		posts = []Post{}
	}
	f := Feed{
		Version:   SchemaVersion,
		Channel:   channel,
		UpdatedAt: updatedAt.UTC().Format(time.RFC3339),
		Posts:     posts,
	}
	if len(posts) > 0 {
		latest := posts[len(posts)-1]
		f.Latest = &latest
	}
	return f
}
