package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/diag"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// diagnostics builds the report for GET /v1/diagnostics and `harness doctor`.
func diagnostics(cfg config.Config, reg *plugins.Registry, octo *router.Router, builtinOK bool, builtinWhy string,
	ring *diag.LogRing, probe func(plugins.Agent) plugins.ProbeReport) diag.Report {
	in := diag.Inputs{
		Version: bridge.Version, DataDir: cfg.DataDir, Agents: reg.Agents(), BuiltinOK: builtinOK, BuiltinWhy: builtinWhy,
		BaseURL: cfg.BaseURL, Log: ring, Probe: probe,
	}
	if octo != nil {
		in.RouterOn, in.RouterCaps = octo.Enabled(), octo.Capabilities()
	}
	return diag.Build(in)
}

// cmdDoctor prints what is needed to understand a problem: versions, the data
// directory, the PATH agents get, each agent's resolution, login probe (run now)
// and hints. `--json` prints the same as GET /v1/diagnostics (which also has the
// log tail of a running harness). Takes the flags of serve.
func cmdDoctor(args []string) error {
	asJSON := false
	rest := args[:0:0]
	for _, a := range args {
		if a == "--json" {
			asJSON = true
			continue
		}
		rest = append(rest, a)
	}
	cfg, _, err := serveConfig(rest)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	reg := loadPlugins(ctx, cfg, tools.NewRegistry())
	ok, why := cfg.BuiltinLoop()
	var octo *router.Router
	if cfg.BaseURL != "" {
		octo = router.New(ctx, cfg.BaseURL, cfg.OctoKey, router.WithAPIKey(cfg.APIKey))
	}
	rep := diagnostics(cfg, reg, octo, ok, why, nil, func(a plugins.Agent) plugins.ProbeReport { return a.ProbeNow(ctx) })
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(rep)
	}
	_, err = fmt.Fprint(os.Stdout, rep.Text())
	return err
}
