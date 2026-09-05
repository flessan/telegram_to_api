package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the official Bot API endpoint. The bot token is appended as
// a path segment by the client, never logged.
const DefaultBaseURL = "https://api.telegram.org"

// APIError is returned when Telegram answers with ok:false. It deliberately
// carries only the non-secret description returned by Telegram.
type APIError struct {
	Method      string
	Code        int
	Description string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("telegram api %s failed (code %d): %s", e.Method, e.Code, e.Description)
}

// Client is a minimal Telegram Bot API client.
type Client struct {
	token   string
	baseURL string
	http    *http.Client
	// Retries is the number of extra attempts for transient failures.
	Retries int
	// RetryDelay is the pause between attempts.
	RetryDelay time.Duration
}

// New builds a client with sane timeouts. baseURL may be empty for the default.
func New(token, baseURL string, timeout time.Duration) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		token:      token,
		baseURL:    strings.TrimRight(baseURL, "/"),
		http:       &http.Client{Timeout: timeout},
		Retries:    2,
		RetryDelay: 2 * time.Second,
	}
}

// redact removes the bot token from any string that may end up in a log line.
func (c *Client) redact(s string) string {
	if c.token == "" {
		return s
	}
	return strings.ReplaceAll(s, c.token, "REDACTED")
}

// call performs a GET request against a Bot API method and decodes the body
// into out. Errors never contain the token or the full request URL.
func (c *Client) call(ctx context.Context, method string, params url.Values, out any) error {
	endpoint := fmt.Sprintf("%s/bot%s/%s", c.baseURL, c.token, method)
	if len(params) > 0 {
		endpoint += "?" + params.Encode()
	}

	var lastErr error
	attempts := c.Retries + 1
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.RetryDelay):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			// Malformed configuration: retrying will not help.
			return fmt.Errorf("build request for %s: %s", method, c.redact(err.Error()))
		}

		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("request %s failed: %s", method, c.redact(err.Error()))
			continue
		}

		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("read %s response: %s", method, c.redact(readErr.Error()))
			continue
		}

		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			lastErr = &APIError{Method: method, Code: resp.StatusCode, Description: http.StatusText(resp.StatusCode)}
			continue
		}

		if err := json.Unmarshal(body, out); err != nil {
			lastErr = fmt.Errorf("decode %s response: invalid JSON returned by Telegram", method)
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("unknown telegram error")
	}
	return lastErr
}

// GetMe verifies that the configured bot token is valid.
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var out getMeResponse
	if err := c.call(ctx, "getMe", nil, &out); err != nil {
		return User{}, err
	}
	if !out.OK {
		return User{}, &APIError{Method: "getMe", Code: out.ErrorCode, Description: out.Description}
	}
	return out.Result, nil
}

// GetUpdates fetches pending updates starting at offset. Only channel post
// updates are requested to keep the queue small and avoid consuming unrelated
// update types.
func (c *Client) GetUpdates(ctx context.Context, offset int64, limit int) ([]Update, error) {
	params := url.Values{}
	if offset > 0 {
		params.Set("offset", strconv.FormatInt(offset, 10))
	}
	if limit > 0 {
		params.Set("limit", strconv.Itoa(limit))
	}
	params.Set("timeout", "0") // short polling: GitHub Actions runs are not long lived
	params.Set("allowed_updates", `["channel_post","edited_channel_post"]`)

	var out getUpdatesResponse
	if err := c.call(ctx, "getUpdates", params, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, &APIError{Method: "getUpdates", Code: out.ErrorCode, Description: out.Description}
	}
	return out.Result, nil
}
