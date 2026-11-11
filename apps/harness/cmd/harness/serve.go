package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acptrace"
	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/diag"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/limits"
	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
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
	if cfg.ExitOnStdinClose {
		go watchStdin(os.Stdin, stop)
	}
	return serve(ctx, cfg, addr)
}

// watchStdin reads r until it ends (EOF or error: the parent is gone) and then
// calls stop, which takes the same graceful path as SIGTERM. Whatever is read
// is discarded.
func watchStdin(r io.Reader, stop func()) {
	_, _ = io.Copy(io.Discard, r)
	slog.Info("standard input closed; shutting down")
	stop()
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
	exitOnStdin := fs.Bool("exit-on-stdin-close", false, "Shut down gracefully when standard input reaches EOF (or HARNESS_EXIT_ON_STDIN_CLOSE=1); for a parent that may die without stopping us")
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
	fromFile := config.LoadEnvFile(config.ResolveDataDir(*dataDir))
	// The operator allow-list of child processes was read before the file was.
	childenv.SetAllow(os.Getenv(childenv.AllowEnvVar))
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
	if *exitOnStdin || os.Getenv("HARNESS_EXIT_ON_STDIN_CLOSE") == "1" {
		cfg.ExitOnStdinClose = true
	}
	if len(remoteBases) > 0 {
		cfg.RemoteBases = remoteBases
	}
	cfg.PluginDirs = append(cfg.PluginDirs, pluginDirs...)
	cfg.EnvFromFile = fromFile
	return cfg, *addr, nil
}

// logRing keeps the last log lines for diagnostics; main installs it.
var logRing = diag.NewLogRing(diag.LogLines)

func init() {
	base := diag.LegacyHandler(log.New(log.Writer(), log.Prefix(), log.Flags()))
	slog.SetDefault(slog.New(logRing.Wrap(base)))
}

func traceOn(v string) bool { b, err := strconv.ParseBool(v); return err == nil && b }

func serve(ctx context.Context, cfg config.Config, addr string) error {
	access, approvalTimeout, err := v7Env()
	if err != nil {
		return err
	}
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

	acptrace.Configure(cfg.DataDir, traceOn(os.Getenv("HARNESS_ACP_TRACE")))
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
		ApprovalTimeout: approvalTimeout,

		BuiltinUnavailable:  builtinReason,
		DefaultOrchestrator: cfg.Models.Orchestrator,
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: cfg.Models, MaxDepth: config.DefaultMaxDepth, Access: access},
		project.WithPrices(priceTable), project.WithRouter(octo), project.WithACPAgents(pluginReg))
	// A model setting that names an ACP agent must name a loaded, available one.
	// A settings file written earlier can name an agent that has since gone
	// away; the app must still start so the setting can be fixed in it.
	if err := svc.ValidateModels(&cfg.Models); err != nil {
		slog.Warn("default models ignored: falling back to the built-in models", "err", err)
		cfg.Models = config.BuiltinModels()
		svc.SetDefaultTiers(cfg.Models.Orchestrator, cfg.Models.Fast, cfg.Models.Balanced, cfg.Models.Deep)
		orch.SetDefaultOrchestrator(cfg.Models.Orchestrator)
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
	settingsMgr := settings.New(settings.Options{
		DataDir: cfg.DataDir, FromFile: cfg.EnvFromFile, ValidateModels: svc.ValidateModels,
		Apply: settings.Applier{
			Models: func(o, f, b, d string) {
				svc.SetDefaultTiers(o, f, b, d)
				orch.SetDefaultOrchestrator(o)
			},
			ChildEnvAllow: childenv.SetAllow,
			ACPTrace:      acptrace.SetEnabled,
		},
		Notify: func(ids []string) { hub.PublishAll(events.SettingsChanged, map[string]any{"ids": ids}) },
	})
	baseCtx, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	srv := &http.Server{
		Handler: bridge.New(svc, notes, project.NewFiles(store, hub),
			bridge.WithMCP(orch.MCPHandler(bridge.Version)),
			bridge.WithPlugins(pluginReg), bridge.WithLSP(pluginReg, lspMgr), bridge.WithLimits(limitStore), bridge.WithRouter(octo),
			bridge.WithSettings(settingsMgr, isLoopbackAddr(ln.Addr())), bridge.WithBuiltinLoop(builtinOK, builtinReason), bridge.WithDefaultOrchestrator(orch.DefaultOrchestrator),
			bridge.WithDiagnostics(func() any { return diagnostics(cfg, pluginReg, octo, builtinOK, builtinReason, logRing, nil) })),
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

// isLoopbackAddr is true for a listener bound to a loopback IP; 0.0.0.0 and
// :: (every interface) are not.
func isLoopbackAddr(a net.Addr) bool {
	t, ok := a.(*net.TCPAddr)
	return ok && t.IP != nil && t.IP.IsLoopback()
}

func portOf(a net.Addr) string {
	if t, ok := a.(*net.TCPAddr); ok {
		return strconv.Itoa(t.Port)
	}
	_, p, _ := net.SplitHostPort(a.String())
	return p
}

// v7Env reads the v7 settings from the environment (harness.env fills it):
// HARNESS_DEFAULT_ACCESS, the access mode of projects created without one
// ("full", the default until the UI shows approval cards, or "supervised"), and HARNESS_APPROVAL_TIMEOUT, how long
// an approval request waits for an answer before it is denied (a Go duration,
// default 30m; "0" or negative: wait for ever).
func v7Env() (access string, timeout time.Duration, err error) {
	access = os.Getenv("HARNESS_DEFAULT_ACCESS")
	switch access {
	case "":
		// full until the UI shows approval cards; then this flips to supervised
		access = projectstore.AccessFull
	case projectstore.AccessSupervised, projectstore.AccessFull:
	default:
		return "", 0, fmt.Errorf("HARNESS_DEFAULT_ACCESS must be %q or %q", projectstore.AccessSupervised, projectstore.AccessFull)
	}
	if v := os.Getenv("HARNESS_APPROVAL_TIMEOUT"); v != "" {
		d, perr := time.ParseDuration(v)
		if perr != nil {
			return "", 0, fmt.Errorf("HARNESS_APPROVAL_TIMEOUT: %w", perr)
		}
		if d == 0 {
			d = -1
		}
		timeout = d
	}
	return access, timeout, nil
}
