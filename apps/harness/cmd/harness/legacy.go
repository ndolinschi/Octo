package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/store"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/remote"
)

func openStore(dataDir string) (*store.Store, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if dataDir != "" {
		cfg.DataDir = dataDir
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	return store.Open(cfg.DataDir)
}

func cmdSessions(args []string) error {
	fs := flag.NewFlagSet("sessions", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dataDir := fs.String("data-dir", "", "Harness data directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	list, err := st.ListSessions(context.Background())
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(list)
}

func cmdShow(args []string) error {
	fs := flag.NewFlagSet("show", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dataDir := fs.String("data-dir", "", "Harness data directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return fmt.Errorf("session id required")
	}
	sessionID := fs.Arg(0)
	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	msgs, err := st.GetMessages(context.Background(), sessionID)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(msgs)
}

func cmdRun(args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	prompt := fs.String("prompt", "", "User prompt (required)")
	workspace := fs.String("workspace", ".", "Workspace root for local tools")
	baseURL := fs.String("base-url", "", "Anthropic Messages API base URL")
	model := fs.String("model", "claude-sonnet-4-5", "Model id")
	dataDir := fs.String("data-dir", "", "Harness data directory")
	maxTurns := fs.Int("max-turns", 0, "Max agent turns (0 = config default)")
	octoKey := fs.String("octo-key", "", "Octo x-octo-key (or HARNESS_OCTO_KEY)")
	promptCaching := fs.Bool("prompt-caching", cfg.PromptCaching, "Send cache_control breakpoints (or HARNESS_PROMPT_CACHING)")
	stream := fs.Bool("stream", cfg.Stream, "Stream assistant text to stderr (or HARNESS_STREAM)")
	var remoteBases multiFlag
	fs.Var(&remoteBases, "remote", "Remote tool server base URL (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *prompt == "" {
		return fmt.Errorf("--prompt is required")
	}
	if *dataDir != "" {
		cfg.DataDir = *dataDir
	}
	if *baseURL != "" {
		cfg.BaseURL = *baseURL
	}
	if *octoKey != "" {
		cfg.OctoKey = *octoKey
	}
	if *maxTurns > 0 {
		cfg.MaxTurns = *maxTurns
	}
	cfg.Stream = *stream
	cfg.PromptCaching = *promptCaching
	cfg.Model = *model
	cfg.Workspace = *workspace
	if len(remoteBases) > 0 {
		cfg.RemoteBases = remoteBases
	}

	if cfg.APIKey == "" {
		return fmt.Errorf("ANTHROPIC_API_KEY is required")
	}

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	reg := tools.NewRegistry()
	if err := local.RegisterRootsLimits(reg, []local.Root{{Label: "workspace", Path: cfg.Workspace}}, cfg.Limits); err != nil {
		return err
	}
	cacheDir := filepath.Join(cfg.DataDir, "cache")
	ctx := context.Background()
	if err := remote.Register(ctx, reg, cfg.RemoteBases, cacheDir); err != nil {
		return err
	}

	client := anthropicclient.New(cfg.APIKey, cfg.BaseURL, cfg.OctoKey)
	runner := agent.Runner{
		Client:   client,
		Registry: reg,
		Store:    st,
		Model:    cfg.Model,
		MaxTurns: cfg.MaxTurns,
		Stream:   cfg.Stream,

		NoPromptCaching: !cfg.PromptCaching,
		Limits:          cfg.Limits,
	}
	sessionID, finalText, err := runner.Run(ctx, *prompt)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "session: %s\n", sessionID)
	fmt.Print(finalText)
	return nil
}
