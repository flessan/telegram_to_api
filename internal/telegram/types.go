// Package telegram contains a tiny, dependency-free client for the subset of
// the official Telegram Bot API that this collector needs: getMe and getUpdates.
//
// Only the fields that the collector actually uses are decoded. Everything else
// in the raw Telegram payload is intentionally dropped so that it can never leak
// into the generated public JSON feed.
package telegram

// Response is the envelope returned by every Bot API method.
type Response struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	ErrorCode   int    `json:"error_code"`
}

// User describes the bot itself (result of getMe).
type User struct {
	ID       int64  `json:"id"`
	IsBot    bool   `json:"is_bot"`
	Username string `json:"username"`
	Name     string `json:"first_name"`
}

// Chat is the channel a post belongs to.
type Chat struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	Username string `json:"username"`
}

// PhotoSize is one of the available renditions of a photo.
type PhotoSize struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	FileSize     int    `json:"file_size"`
}

// Document, Video, Audio and Voice are only classified, not fully decoded.
type Document struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	MimeType     string `json:"mime_type"`
	FileSize     int    `json:"file_size"`
}

// Video mirrors Telegram's Video object (subset).
type Video struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Duration     int    `json:"duration"`
	MimeType     string `json:"mime_type"`
	FileSize     int    `json:"file_size"`
}

// Message is a channel post (subset of Telegram's Message object).
type Message struct {
	MessageID      int64       `json:"message_id"`
	Date           int64       `json:"date"`
	EditDate       int64       `json:"edit_date"`
	Chat           Chat        `json:"chat"`
	Text           string      `json:"text"`
	Caption        string      `json:"caption"`
	Photo          []PhotoSize `json:"photo"`
	Document       *Document   `json:"document"`
	Video          *Video      `json:"video"`
	MediaGroupID   string      `json:"media_group_id"`
	SenderChatName string      `json:"author_signature"`
}

// Update is a single entry of getUpdates.
type Update struct {
	UpdateID          int64    `json:"update_id"`
	ChannelPost       *Message `json:"channel_post"`
	EditedChannelPost *Message `json:"edited_channel_post"`
}

type getUpdatesResponse struct {
	Response
	Result []Update `json:"result"`
}

type getMeResponse struct {
	Response
	Result User `json:"result"`
}
