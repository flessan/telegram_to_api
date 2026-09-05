// Command collector fetches new channel posts from the Telegram Bot API and
// writes them into a small static JSON feed (data/posts.json).
//
// Configuration is environment-driven only; no secret is ever printed.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/flessan/telegram_to_api/internal/collector"
	"github.com/flessan/telegram_to_api/internal/telegram"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("collector: ")

	if err := run(); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

func run() error {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" {
		return fmt.Errorf("TELEGRAM_BOT_TOKEN is not set")
	}
	rawChannel := os.Getenv("TELEGRAM_CHANNEL_ID")
	if rawChannel == "" {
		return fmt.Errorf("TELEGRAM_CHANNEL_ID is not set")
	}
	channelID, err := strconv.ParseInt(rawChannel, 10, 64)
	if err != nil {
		return fmt.Errorf("TELEGRAM_CHANNEL_ID must be a numeric chat id such as -1001234567890")
	}

	opt := collector.Options{
		ChannelID: channelID,
		FeedPath:  envOr("FEED_PATH", "data/posts.json"),
		StatePath: envOr("STATE_PATH", "data/state.json"),
		PostLimit: envInt("POST_LIMIT", 20),
		Verify:    envOr("VERIFY_TOKEN", "true") != "false",
	}

	timeout := time.Duration(envInt("HTTP_TIMEOUT_SECONDS", 30)) * time.Second
	client := telegram.New(token, os.Getenv("TELEGRAM_API_BASE_URL"), timeout)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	res, err := collector.Run(ctx, client, opt)
	if err != nil {
		return err
	}

	log.Printf("fetched %d update(s), %d relevant channel post(s), feed changed: %t",
		res.FetchedUpdates, res.RelevantPosts, res.Changed)
	return nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		log.Printf("warning: %s is not a positive integer, using default %d", key, fallback)
		return fallback
	}
	return n
}
