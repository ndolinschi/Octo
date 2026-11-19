package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acptrace"
	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/apitoken"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/browserproxy"
	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/commands"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/datalock"
	"github.com/ndolinschi/Octo/apps/harness/internal/diag"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/features"
	"github.com/ndolinschi/Octo/apps/harness/internal/limits"
	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/proctree"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/remoteaccess"
	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/remote"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
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
	remoteWebDir := fs.String("remote-web-dir", "", "Built mobile web app served to paired devices (or HARNESS_REMOTE_WEB_DIR)")
	noAPIToken := fs.Bool("no-api-token", false, "Do not require the API token on /v1 routes (or HARNESS_NO_API_TOKEN=1); for tests and scripts that have not been updated")
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
	if *noAPIToken {
		cfg.NoAPIToken = true
	}
	if *remoteWebDir != "" {
		// Read by setupRemote like the variable it stands for.
		if err := os.Setenv(remoteaccess.EnvWebDir, *remoteWebDir); err != nil {
			return config.Config{}, "", err
		}
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

// providersWatchEvery is how often the provider picture is re-read for what no
// hook reports (the router answering, or going away).
const providersWatchEvery = 15 * time.Second

// modelDiscovery configures model discovery of ACP agents (see providers.Discovery);
// HARNESS_MODEL_DISCOVERY=0 turns it off, and agents then show only the manifest's
// models, those they advertised in real sessions and the names typed by the user.
func modelDiscovery(orchRef *atomic.Pointer[orchestrator.Orchestrator]) *providers.Discovery {
	if v, ok := os.LookupEnv("HARNESS_MODEL_DISCOVERY"); ok && !traceOn(v) {
		return nil
	}
	return &providers.Discovery{
		InUse: func(id string) bool {
			o := orchRef.Load()
			return o != nil && o.AgentInUse(id)
		},
		Live: func(id string) ([]providers.ModelInfo, string, bool) {
			o := orchRef.Load()
			if o == nil {
				return nil, "", false
			}
			a, ok := o.AdvertisedModels(id)
			if !ok || len(a.Models) == 0 {
				return nil, "", false
			}
			infos := make([]providers.ModelInfo, len(a.Models))
			for i, m := range a.Models {
				infos[i] = providers.ModelInfo{ID: m.ID, Label: m.Label}
			}
			return infos, a.Current, true
		},
	}
}

func traceOn(v string) bool { b, err := strconv.ParseBool(v); return err == nil && b }

func serve(ctx context.Context, cfg config.Config, addr string) error {
	access, approvalTimeout, err := v7Env()
	if err != nil {
		return err
	}
	// One service per data folder: the lock comes before the store is opened, migrated or recovered, so a second
	// `harness serve` on a folder in use stops here instead of rewriting the running instance's turns.
	lock, err := datalock.Acquire(cfg.DataDir)
	if err != nil {
		if errors.Is(err, datalock.ErrInUse) {
			u := usererr.DataDirInUse(cfg.DataDir, err.Error()).Caused(err)
			return fmt.Errorf("%w %s (%s)", u, u.Hint, cfg.DataDir)
		}
		if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS) {
			u := usererr.DataDirUnwritable(cfg.DataDir, err.Error()).Caused(err)
			return fmt.Errorf("%w %s (%s)", u, u.Hint, u.Details)
		}
		return err
	}
	defer func() {
		if err := lock.Release(); err != nil {
			slog.Error("release data folder lock", "err", err)
		}
	}()
	// Terminal shells and Processes runs a previous instance left running (it was killed) are stopped, matched by
	// pid and start time; this one records its own in the same file.
	children := proctree.OpenLedger(cfg.DataDir)
	children.Reap(proctree.DefaultGrace)
	store, err := projectstore.Open(cfg.DataDir)
	if err != nil {
		// The list of projects cannot be worked around: stop, naming the file and what to do; it is left untouched.
		if u := usererr.As(err); u != nil {
			return fmt.Errorf("%w %s (%s)", u, u.Hint, u.Details)
		}
		return err
	}
	defer func() {
		if err := store.Close(); err != nil {
			slog.Error("close store", "err", err)
		}
	}()
	// Cancelled before the store closes (defers run in reverse), so background work started below stops quietly.
	ctx, cancelStore := context.WithCancel(ctx)
	defer cancelStore()

	apiToken, err := setupAPIToken(cfg)
	if err != nil {
		return err
	}

	remoteReg := tools.NewRegistry()
	if err := remote.Register(ctx, remoteReg, cfg.RemoteBases, filepath.Join(cfg.DataDir, "cache")); err != nil {
		return err
	}

	pluginReg := loadPlugins(ctx, cfg, remoteReg)

	priceTable, err := prices.Load(filepath.Join(cfg.DataDir, prices.File))
	if err != nil {
		slog.Warn("ignoring price table; costs will be unknown", "err", err)
	}
	limitStore := limits.NewStore()
	// The Messages API key can change while the process runs (the settings
	// screen writes it), so everything that sends it reads it from here.
	keys := config.NewKeySource(cfg.APIKey)
	builtin := func() (bool, string) {
		c := cfg
		c.APIKey = keys.Get()
		return c.BuiltinLoop()
	}
	octo := router.New(ctx, cfg.BaseURL, cfg.OctoKey, router.WithRouteTimeout(cfg.RouteTimeout), router.WithAPIKeyFunc(keys.Get))
	slog.Info("octo router", "detected", octo.Enabled(), "capabilities", octo.Capabilities())
	builtinOK, builtinReason := builtin()
	if !builtinOK {
		slog.Info("built-in agent loop unavailable; ACP agents still work", "reason", builtinReason)
	}

	acptrace.Configure(cfg.DataDir, traceOn(os.Getenv("HARNESS_ACP_TRACE")))
	hub := events.NewHub()
	// svc exists only after the orchestrator; a probe result can arrive before that.
	var svcRef atomic.Pointer[project.Service]
	var orchRef atomic.Pointer[orchestrator.Orchestrator]
	provSvc := providers.New(providers.Options{
		Discovery: modelDiscovery(&orchRef),
		DataDir:   cfg.DataDir, Builtin: builtin, Router: octo, Agents: pluginReg.Agents, Recheck: pluginReg.Recheck, Fresh: pluginReg.Fresh,
		// Ollama, and the built-in loop on a local base URL, read ready only while their server answers.
		Reach: providers.HTTPReach, APIBaseURL: func() string { return cfg.BaseURL },
		Ollama: func() (string, string) {
			if o := orchRef.Load(); o != nil {
				return o.OllamaConfig()
			}
			return cfg.OllamaBaseURL, cfg.Models.SmallModel()
		},
		Defaults: func() config.Models {
			if s := svcRef.Load(); s != nil {
				return s.Defaults().Models
			}
			return cfg.Models
		},
		Publish: func(n int) { hub.PublishAll(events.ProvidersUpdated, map[string]any{"connected": n}) },
	})
	featureStore := features.NewStore(os.LookupEnv)
	pluginReg.OnProbeChange(provSvc.Refresh)
	pluginReg.StartProbes(ctx)
	notes := project.NewNotes(store, hub)
	orch := orchestrator.New(store, hub, notes, orchestrator.Options{
		Client:   anthropicclient.New(cfg.APIKey, cfg.BaseURL, cfg.OctoKey, anthropicclient.WithResponseObserver(limitStore.Observe), anthropicclient.WithKeyFunc(keys.Get)),
		MaxTurns: cfg.MaxTurns,
		Stream:   cfg.Stream,

		NoPromptCaching: !cfg.PromptCaching,
		Limits:          cfg.Limits,
		Remote:          remoteReg.All(),
		Agents:          pluginReg.Agents(),
		AgentSource:     provSvc.Agents,
		Router:          octo,
		Prices:          priceTable,
		Windows:         cfg.ContextWindows,
		ACPIdle:         cfg.ACPIdle,
		MaxRunning:      cfg.MaxRunningSessions,
		ApprovalTimeout: approvalTimeout,
		MemoryDigest:    true,
		SessionTitle:    true,
		Features:        featureStore,

		BuiltinUnavailable:   builtinReason,
		OllamaBaseURL:        cfg.OllamaBaseURL,
		SmallCompletionModel: cfg.Models.Small,
		DefaultOrchestrator:  cfg.Models.Orchestrator,
	})
	orchRef.Store(orch)
	orch.OnAdvertisedModels(func(agentID string) {
		if a, ok := orch.AdvertisedModels(agentID); ok {
			infos := make([]providers.ModelInfo, len(a.Models))
			for i, m := range a.Models {
				infos[i] = providers.ModelInfo{ID: m.ID, Label: m.Label}
			}
			provSvc.RecordModels(agentID, infos, a.Current)
		}
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: cfg.Models, MaxDepth: config.DefaultMaxDepth, Access: access},
		project.WithPrices(priceTable), project.WithRouter(octo), project.WithACPAgents(provSvc), project.WithProviders(provSvc))
	svcRef.Store(svc)
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
	termMgr := terminal.NewManager(terminal.Options{Children: children})
	// PR review (RV1): the `gh` adapter; worktrees of finished reviews are swept at start and every 6 hours.
	reviews := review.New(store, hub, review.Options{Host: codehost.NewGH()})
	go reviews.Run(ctx, 6*time.Hour)
	// Project commands (decision 68): started only by the user's own HTTP call, never by an agent.
	cmds := commands.New(store, hub, commands.Options{Children: children})
	cmds.Recover(ctx)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	if !isLoopbackAddr(ln.Addr()) {
		// Other computers can reach this address; every /v1 route still needs the API token.
		slog.Warn("listening on a non-loopback address: other computers on the network can reach the harness; "+
			"/v1 routes still require the API token", "addr", ln.Addr().String(), "token_required", !cfg.NoAPIToken)
	}
	listenPort, _ := strconv.Atoi(portOf(ln.Addr()))
	browserMgr := browserproxy.NewManager(browserproxy.Options{BlockedLoopbackPorts: []int{listenPort}})
	orch.SetBridgeURL("http://" + net.JoinHostPort(loopbackHost(ln.Addr()), portOf(ln.Addr())))
	settingsMgr := settings.New(settings.Options{
		DataDir: cfg.DataDir, FromFile: cfg.EnvFromFile, ValidateModels: svc.ValidateModels,
		Apply: settings.Applier{
			Models: func(o, f, b, d string) {
				svc.SetDefaultTiers(o, f, b, d)
				orch.SetDefaultOrchestrator(o)
			},
			Ollama:        orch.SetOllama,
			ChildEnvAllow: childenv.SetAllow,
			ACPTrace:      acptrace.SetEnabled,
			Features:      featureStore.Set,
			APIKey: func(key string) {
				keys.Set(key)
				_, why := builtin()
				orch.SetBuiltinUnavailable(why)
			},
		},
		Notify: func(ids []string) {
			hub.PublishAll(events.SettingsChanged, map[string]any{"ids": ids})
			provSvc.Refresh() // publishes providers.updated when a key or a default model changed what can run
		},
	})
	baseCtx, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	files := project.NewFiles(store, hub)
	bridgeOpts := []bridge.Option{
		bridge.WithReviews(reviews), bridge.WithCommands(cmds), bridge.WithBrowserProxy(browserMgr), bridge.WithWorkerProcesses(orch),
		bridge.WithPlugins(pluginReg), bridge.WithLSP(pluginReg, lspMgr), bridge.WithTerminals(termMgr), bridge.WithLimits(limitStore), bridge.WithRouter(octo), bridge.WithFeatures(featureStore),
		bridge.WithSettings(settingsMgr, isLoopbackAddr(ln.Addr())), bridge.WithBuiltinLoopFunc(builtin), bridge.WithProviders(provSvc), bridge.WithDefaultOrchestrator(orch.DefaultOrchestrator),
		bridge.WithDiagnostics(func() any {
			ok, why := builtin()
			c := cfg
			c.APIKey = keys.Get() // the key the settings screen may have changed, for the model probe
			return diagnostics(c, pluginReg, octo, ok, why, logRing, nil)
		}),
	}
	// Remote access (spec 2026-11-14-remote-access-mobile-design.md): off at every start; its control routes live
	// on this bridge behind the local token, its own listener opens only when the owner turns it on.
	remote, err := setupRemote(ctx, cfg, svc, notes, files, hub, bridgeOpts)
	if err != nil {
		return err
	}
	defer remote.Close()
	srv := &http.Server{
		Handler: bridge.New(svc, notes, files, append(bridgeOpts,
			bridge.WithAPIToken(apiToken), bridge.WithMCP(orch.MCPHandler(bridge.Version)),
			bridge.WithMount("/v1/remote", remote.ControlHandler()), bridge.WithMount("/v1/remote/", remote.ControlHandler()))...),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	provSvc.Watch(ctx, providersWatchEvery)
	slog.Info("harness serving", "addr", ln.Addr().String(), "data_dir", cfg.DataDir)

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	remote.Close()
	cancelRequests()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := orch.Shutdown(shutdownCtx); err != nil {
		slog.Error("orchestrator shutdown", "err", err)
	}
	cmds.Shutdown(shutdownCtx)
	if err := browserMgr.Shutdown(shutdownCtx); err != nil {
		slog.Error("browser proxy shutdown", "err", err)
	}
	if err := lspMgr.Shutdown(shutdownCtx); err != nil {
		slog.Error("language server shutdown", "err", err)
	}
	if err := termMgr.Shutdown(shutdownCtx); err != nil {
		slog.Error("terminal shutdown", "err", err)
	}
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// setupAPIToken decides the bridge's API token: HARNESS_API_TOKEN when set,
// else a new one written to {data-dir}/api-token (0600); "" with --no-api-token.
// It also keeps the token away from what agents can see: the data directory
// is closed to the file tools and the value is redacted from ACP traces and
// the diagnostics log. Nothing secret is logged.
func setupAPIToken(cfg config.Config) (string, error) {
	if cfg.NoAPIToken {
		slog.Warn("bridge API token is off (--no-api-token / HARNESS_NO_API_TOKEN): any local process can call /v1")
		return "", nil
	}
	local.ProtectDir(cfg.DataDir)
	token, generated, err := apitoken.Resolve(cfg.DataDir, cfg.APIToken)
	if err != nil {
		return "", fmt.Errorf("api token: %w", err)
	}
	acptrace.HideEverywhere(token)
	logRing.Hide(token)
	if generated {
		slog.Info("bridge API token generated", "file", apitoken.Path(cfg.DataDir))
	} else {
		slog.Info("bridge API token taken from " + apitoken.EnvVar)
	}
	return token, nil
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
// ("supervised" by default, "accept_edits", or "full"), and HARNESS_APPROVAL_TIMEOUT, how long
// an approval request waits for an answer before it is denied (a Go duration,
// default 30m; "0" or negative: wait for ever).
func v7Env() (access string, timeout time.Duration, err error) {
	access = os.Getenv("HARNESS_DEFAULT_ACCESS")
	switch access {
	case "":
		access = projectstore.AccessSupervised
	case projectstore.AccessSupervised, projectstore.AccessAcceptEdits, projectstore.AccessFull:
	default:
		return "", 0, fmt.Errorf("HARNESS_DEFAULT_ACCESS must be %q, %q or %q", projectstore.AccessSupervised, projectstore.AccessAcceptEdits, projectstore.AccessFull)
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
