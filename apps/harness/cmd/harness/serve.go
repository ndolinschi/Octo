package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/limits"
	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/remote"
)

func cmdServe(args []string) error {
	cfg, addr, err := serveConfig(args)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serve(ctx, cfg, addr)
}

// serveConfig parses the serve flags and builds the configuration: the
// process environment on top of {data-dir}/harness.env, flags on top of both.
func serveConfig(args []string) (config.Config, string, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	addr := fs.String("addr", config.DefaultAddr, "Listen address")
	dataDir := fs.String("data-dir", "", "Harness data directory (settings file: harness.env inside it)")
	baseURL := fs.String("base-url", "", "Anthropic Messages API base URL")
	octoKey := fs.String("octo-key", "", "Octo x-octo-key (or HARNESS_OCTO_KEY)")
	maxTurns := fs.Int("max-turns", 0, "Max loop iterations per agent (0 = config default)")
	promptCaching := fs.Bool("prompt-caching", true, "Send cache_control breakpoints (or HARNESS_PROMPT_CACHING, default true); disable for gateways that reject them")
	noBuiltin := fs.Bool("no-builtin-plugins", false, "Do not load the plugins embedded in the binary (or HARNESS_NO_BUILTIN_PLUGINS=1)")
	var remoteBases multiFlag
	fs.Var(&remoteBases, "remote", "Remote tool server base URL (repeatable; sub-agents only)")
	var pluginDirs multiFlag
	fs.Var(&pluginDirs, "plugins-dir", "Extra plugins directory (repeatable; also HARNESS_PLUGINS_DIR); a plugin dir or a dir of plugin dirs")
	if err := fs.Parse(args); err != nil {
		return config.Config{}, "", err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })

	// The settings file fills only variables the process environment lacks,
	// so it is read before the environment becomes a Config.
	config.LoadEnvFile(config.ResolveDataDir(*dataDir))
	cfg, err := config.Load()
	if err != nil {
		return config.Config{}, "", err
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
	if set["prompt-caching"] {
		cfg.PromptCaching = *promptCaching
	}
	if *noBuiltin {
		cfg.NoBuiltinPlugins = true
	}
	if len(remoteBases) > 0 {
		cfg.RemoteBases = remoteBases
	}
	cfg.PluginDirs = append(cfg.PluginDirs, pluginDirs...)
	return cfg, *addr, nil
}

func serve(ctx context.Context, cfg config.Config, addr string) error {
	store, err := projectstore.Open(cfg.DataDir)
	if err != nil {
		return err
	}
	defer func() {
		if err := store.Close(); err != nil {
			slog.Error("close store", "err", err)
		}
	}()

	remoteReg := tools.NewRegistry()
	if err := remote.Register(ctx, remoteReg, cfg.RemoteBases, filepath.Join(cfg.DataDir, "cache")); err != nil {
		return err
	}

	pluginReg := loadPlugins(ctx, cfg, remoteReg)
	pluginReg.StartProbes(ctx)

	priceTable, err := prices.Load(filepath.Join(cfg.DataDir, prices.File))
	if err != nil {
		slog.Warn("ignoring price table; costs will be unknown", "err", err)
	}
	limitStore := limits.NewStore()
	octo := router.New(ctx, cfg.BaseURL, cfg.OctoKey, router.WithRouteTimeout(cfg.RouteTimeout), router.WithAPIKey(cfg.APIKey))
	slog.Info("octo router", "detected", octo.Enabled(), "capabilities", octo.Capabilities())
	builtinOK, builtinReason := cfg.BuiltinLoop()
	if !builtinOK {
		slog.Info("built-in agent loop unavailable; ACP agents still work", "reason", builtinReason)
	}

	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	orch := orchestrator.New(store, hub, notes, orchestrator.Options{
		Client:   anthropicclient.New(cfg.APIKey, cfg.BaseURL, cfg.OctoKey, anthropicclient.WithResponseObserver(limitStore.Observe)),
		MaxTurns: cfg.MaxTurns,
		Stream:   cfg.Stream,

		NoPromptCaching: !cfg.PromptCaching,
		Limits:          cfg.Limits,
		Remote:          remoteReg.All(),
		Agents:          pluginReg.Agents(),
		AgentSource:     pluginReg.Agents,
		Router:          octo,
		Prices:          priceTable,
		Windows:         cfg.ContextWindows,
		ACPIdle:         cfg.ACPIdle,

		BuiltinUnavailable:  builtinReason,
		DefaultOrchestrator: cfg.Models.Orchestrator,
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: cfg.Models, MaxDepth: config.DefaultMaxDepth},
		project.WithPrices(priceTable), project.WithRouter(octo), project.WithACPAgents(pluginReg))
	// A model setting that names an ACP agent must name a loaded, available one.
	if err := svc.ValidateModels(&cfg.Models); err != nil {
		return fmt.Errorf("default models: %w", err)
	}
	if err := svc.Recover(ctx); err != nil {
		return fmt.Errorf("restart recovery: %w", err)
	}

	lspMgr := lsp.NewManager(lsp.Options{})
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	orch.SetBridgeURL("http://" + net.JoinHostPort(loopbackHost(ln.Addr()), portOf(ln.Addr())))
	baseCtx, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	srv := &http.Server{
		Handler: bridge.New(svc, notes, project.NewFiles(store, hub),
			bridge.WithMCP(orch.MCPHandler(bridge.Version)),
			bridge.WithPlugins(pluginReg), bridge.WithLSP(pluginReg, lspMgr), bridge.WithLimits(limitStore), bridge.WithRouter(octo),
			bridge.WithBuiltinLoop(builtinOK, builtinReason), bridge.WithDefaultOrchestrator(orch.DefaultOrchestrator)),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	slog.Info("harness serving", "addr", ln.Addr().String(), "data_dir", cfg.DataDir)

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	cancelRequests()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := orch.Shutdown(shutdownCtx); err != nil {
		slog.Error("orchestrator shutdown", "err", err)
	}
	if err := lspMgr.Shutdown(shutdownCtx); err != nil {
		slog.Error("language server shutdown", "err", err)
	}
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// loopbackHost is the host an ACP agent on this machine uses to reach the
// bridge: the listen address when it is a loopback IP, else 127.0.0.1 (the MCP
// server itself accepts loopback peers only).
func loopbackHost(a net.Addr) string {
	if t, ok := a.(*net.TCPAddr); ok && t.IP != nil && t.IP.IsLoopback() {
		return t.IP.String()
	}
	return "127.0.0.1"
}

func portOf(a net.Addr) string {
	if t, ok := a.(*net.TCPAddr); ok {
		return strconv.Itoa(t.Port)
	}
	_, p, _ := net.SplitHostPort(a.String())
	return p
}
