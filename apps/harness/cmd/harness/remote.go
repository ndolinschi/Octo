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
// onListen is told the tunnel listener's port (the Browser tab's proxy blocks it).
func setupRemote(ctx context.Context, cfg config.Config, svc *project.Service, notes *project.Notes, files *project.Files,
	hub *events.Hub, opts []bridge.Option, onListen func(port int)) (*remoteaccess.Manager, error) {
	o := remoteaccess.Options{
		DataDir:   cfg.DataDir,
		API:       bridge.NewAPI(svc, notes, files, opts...),
		Subscribe: svc.Subscribe,
		Publish:   hub.PublishAll,
		OnListen:  onListen,
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
