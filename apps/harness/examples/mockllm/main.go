// Command mockllm is a scripted Anthropic-compatible Messages server for running
// the harness without an API key.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8791", "listen address")
	delay := flag.Duration("delay", 25*time.Millisecond, "pause between streamed chunks")
	flag.Parse()

	srv := &http.Server{Addr: *addr, Handler: mockllm.New(*delay), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown", "err", err)
		}
	}()
	slog.Info("mockllm listening", "addr", *addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
