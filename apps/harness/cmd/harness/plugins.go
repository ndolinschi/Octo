package main

import (
	"context"
	"path/filepath"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/remote"
	subscriptionagents "github.com/ndolinschi/Octo/apps/harness/plugins-examples/subscription-agents"
)

// loadPlugins reads the plugin manifests and registers their tool servers on
// reg, the registry sub-agents share with --remote tools.
func loadPlugins(ctx context.Context, cfg config.Config, reg *tools.Registry) *plugins.Registry {
	cacheDir := filepath.Join(cfg.DataDir, "cache")
	connect := func(ctx context.Context, base string) error {
		return remote.Register(ctx, reg, []string{base}, cacheDir)
	}
	var opts []plugins.LoadOption
	if !cfg.NoBuiltinPlugins {
		opts = append(opts, plugins.WithBuiltin(subscriptionagents.Manifest))
	}
	return plugins.Load(ctx, cfg.DataDir, cfg.PluginDirs, connect, opts...)
}
