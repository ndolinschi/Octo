package main

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/remoteaccess"
)

// setupRemote builds remote access (off) over the same bridge routes the local listener serves, minus the API
// token, MCP and mounts (bridge.NewAPI), and starts its sweeper. The caller closes it on shutdown.
func setupRemote(ctx context.Context, cfg config.Config, svc *project.Service, notes *project.Notes, files *project.Files,
	hub *events.Hub, opts []bridge.Option) (*remoteaccess.Manager, error) {
	o := remoteaccess.Options{
		DataDir:   cfg.DataDir,
		API:       bridge.NewAPI(svc, notes, files, opts...),
		Subscribe: svc.Subscribe,
		Publish:   hub.PublishAll,
		Version:   bridge.Version,
	}
	if err := remoteaccess.OptionsFromEnv(&o, nil); err != nil {
		return nil, err
	}
	m, err := remoteaccess.New(o)
	if err != nil {
		return nil, err
	}
	go m.Run(ctx)
	return m, nil
}
