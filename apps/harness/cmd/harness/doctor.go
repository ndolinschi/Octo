package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acptrace"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/diag"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// diagnostics builds the report for GET /v1/diagnostics and `harness doctor`.
func diagnostics(cfg config.Config, reg *plugins.Registry, octo *router.Router, builtinOK bool, builtinWhy string,
	ring *diag.LogRing, probe func(plugins.Agent) plugins.ProbeReport, tune ...func(*diag.Inputs)) diag.Report {
	in := diag.Inputs{
		Version: bridge.Version, DataDir: cfg.DataDir, Agents: reg.Agents(), BuiltinOK: builtinOK, BuiltinWhy: builtinWhy,
		BaseURL: cfg.BaseURL, Log: ring, Probe: probe,
	}
	if octo != nil {
		in.RouterOn, in.RouterCaps = octo.Enabled(), octo.Capabilities()
	}
	for _, t := range tune {
		t(&in)
	}
	return diag.Build(in)
}

// cmdDoctor prints what is needed to understand a problem: versions, the data
// directory, the PATH agents get, each agent's resolution, login probe (run now)
// and hints. `--json` prints the same as GET /v1/diagnostics (which also has the
// log tail of a running harness). `--show-probe-output` also prints the first
// 20 lines of each login probe's output (text only; it never goes in JSON).
// Takes the flags of serve.
func cmdDoctor(args []string) error {
	asJSON, showOutput := false, false
	rest := args[:0:0]
	for _, a := range args {
		switch a {
		case "--json":
			asJSON = true
		case "--show-probe-output":
			showOutput = true
		default:
			rest = append(rest, a)
		}
	}
	chosen, dirWhy := doctorDataDir(rest)
	if chosen != "" {
		rest = append(rest, "--data-dir", chosen)
	}
	cfg, _, err := serveConfig(rest)
	if err != nil {
		return err
	}
	// The same trace configuration serve makes, so the report's trace line and file list are right.
	acptrace.Configure(cfg.DataDir, traceOn(os.Getenv("HARNESS_ACP_TRACE")))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	reg := loadPlugins(ctx, cfg, tools.NewRegistry())
	ok, why := cfg.BuiltinLoop()
	var octo *router.Router
	if cfg.BaseURL != "" {
		octo = router.New(ctx, cfg.BaseURL, cfg.OctoKey, router.WithAPIKey(cfg.APIKey))
	}
	rep := diagnostics(cfg, reg, octo, ok, builtinWhy(why), nil, func(a plugins.Agent) plugins.ProbeReport { return a.ProbeNow(ctx) },
		func(in *diag.Inputs) {
			in.DataDirWhy = dirWhy
			in.ShowProbeOutput = showOutput && !asJSON
			// The desktop app starts the router and gives the harness its address;
			// doctor starts nothing, so with the router switched on and no address
			// the built-in loop is simply not checked, not broken.
			in.RouterPending = routerSwitchedOn() && cfg.BaseURL == ""
		})
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(rep)
	}
	_, err = fmt.Fprint(os.Stdout, rep.Text())
	return err
}

// builtinWhy is the reason as is; kept as a seam for the report.
func builtinWhy(why string) string { return why }

// routerSwitchedOn reads OCTO_ROUTER_ENABLED (set by harness.env or the environment).
func routerSwitchedOn() bool {
	b, err := strconv.ParseBool(strings.TrimSpace(os.Getenv("OCTO_ROUTER_ENABLED")))
	return err == nil && b
}
