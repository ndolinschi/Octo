package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ndolinschi/Octo/harness/internal/agent"
	"github.com/ndolinschi/Octo/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/harness/internal/config"
	"github.com/ndolinschi/Octo/harness/internal/store"
	"github.com/ndolinschi/Octo/harness/internal/tools"
	"github.com/ndolinschi/Octo/harness/internal/tools/local"
	"github.com/ndolinschi/Octo/harness/internal/tools/remote"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "run" {
		fmt.Fprintf(os.Stderr, "usage: harness run --prompt \"...\" [flags]\n")
		os.Exit(2)
	}
	if err := run(os.Args[2:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
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
	if err := local.Register(reg, cfg.Workspace); err != nil {
		return err
	}
	cacheDir := filepath.Join(cfg.DataDir, "cache")
	ctx := context.Background()
	if err := remote.Register(ctx, reg, cfg.RemoteBases, cacheDir); err != nil {
		return err
	}

	client := anthropicclient.New(cfg.APIKey, cfg.BaseURL)
	runner := agent.Runner{
		Client:   client,
		Registry: reg,
		Store:    st,
		Model:    cfg.Model,
		MaxTurns: cfg.MaxTurns,
	}
	_, finalText, err := runner.Run(ctx, *prompt)
	if err != nil {
		return err
	}
	fmt.Print(finalText)
	return nil
}

type multiFlag []string

func (m *multiFlag) String() string {
	return ""
}

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}
