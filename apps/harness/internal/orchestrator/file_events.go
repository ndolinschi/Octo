package orchestrator

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/instructions"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/webfetch"
)

// tracker is the project's change tracker, created on first use. It publishes
// change.recorded and file.changed for every change it records.
func (o *Orchestrator) tracker(db *projectstore.DB) *changes.Tracker {
	o.mu.Lock()
	defer o.mu.Unlock()
	t := o.trackers[db.ID()]
	if t == nil {
		t = changes.NewTracker(db)
		pid := db.ID()
		t.OnChange = func(c projectstore.Change) {
			o.hub.Publish(pid, events.ChangeRecorded, map[string]any{"turn_id": c.TurnID, "change": changes.ToFileChange(c)})
			o.hub.Publish(pid, events.FileChanged, map[string]any{"folder": c.Folder, "path": c.Path, "source": events.SourceAgent})
			if instructions.IsInstructionFile(c.Path) {
				o.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid})
			}
		}
		o.trackers[pid] = t
	}
	return t
}

func (o *Orchestrator) dropTracker(pid string) {
	o.mu.Lock()
	delete(o.trackers, pid)
	o.mu.Unlock()
}

func (rt *runtime) changeFolders() []changes.Folder {
	out := make([]changes.Folder, len(rt.folders))
	for i, f := range rt.folders {
		out[i] = changes.Folder{Label: f.Label, Path: f.Path}
	}
	return out
}

func (rt *runtime) tracker() *changes.Tracker { return rt.o.tracker(rt.db) }

func (rt *runtime) scope(agentID, toolUseID, source string) changes.Scope {
	return changes.Scope{TurnID: rt.turnID, AgentID: agentID, ToolUseID: toolUseID, Source: source}
}

// trackSpan opens a snapshot window over the project folders (a bash call, or
// an ACP agent's run, whose own tools can edit files without fs/*). The
// returned func closes it and records what changed. No folders: a no-op.
func (rt *runtime) trackSpan(ctx context.Context, agentID, toolUseID, source string) func() {
	if len(rt.folders) == 0 {
		return func() {}
	}
	t, folders := rt.tracker(), rt.changeFolders()
	t.Begin(ctx, folders)
	return func() { t.End(ctx, folders, rt.scope(agentID, toolUseID, source)) }
}

// folderOf maps a tool call's folder label ("" = the first) onto a folder.
func (rt *runtime) folderOf(label string) (projectstore.Folder, bool) {
	if len(rt.folders) == 0 {
		return projectstore.Folder{}, false
	}
	if label == "" {
		return rt.folders[0], true
	}
	for _, f := range rt.folders {
		if f.Label == label {
			return f, true
		}
	}
	return projectstore.Folder{}, false
}

// guardTools wraps the agent's write_file and bash: what they change is
// recorded (write_file exactly, bash by before/after snapshots) and announced.
func (rt *runtime) guardTools(reg *tools.Registry, a projectstore.Agent) {
	if len(rt.folders) == 0 {
		return
	}
	// write_file and edit go through the same approval and change recording: what
	// the file will hold is worked out first (the approval shows it as a diff),
	// then the tool runs and the change is recorded.
	rt.guardWrite(reg, a, local.ToolWriteFile, func(in json.RawMessage, abs string) (string, bool) {
		var w struct{ Content string }
		_ = json.Unmarshal(in, &w)
		return w.Content, true
	})
	rt.guardWrite(reg, a, local.ToolEdit, func(in json.RawMessage, abs string) (string, bool) {
		var e local.EditInput
		if json.Unmarshal(in, &e) != nil {
			return "", false
		}
		content, err := local.ReadTextFile(abs)
		if err != nil {
			return "", false // the tool itself reports why
		}
		out, _, err := local.ComputeEdit(content, e.OldString, e.NewString, e.ReplaceAll)
		return out, err == nil
	})
	reg.Redefine(local.ToolBash, func(d tools.Def) tools.Def {
		d.InputSchema = bashEnvSchema(d.InputSchema)
		return d
	})
	reg.Decorate(local.ToolBash, func(next tools.Handler) tools.Handler {
		return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			var in struct {
				Command, Folder string
				Env             map[string]string
			}
			_ = json.Unmarshal(input, &in)
			if f, ok := rt.folderOf(in.Folder); ok && strings.TrimSpace(in.Command) != "" {
				if ok, note := rt.approveCommand(ctx, a.ID, agentLabel(a), f.Label, in.Command); !ok {
					return denied(note), true, nil
				}
			}
			// Secrets are filled in here, from references, and never appear in the
			// tool input (which is stored); the output is scrubbed of every stored
			// secret before it can reach the transcript or the model.
			env, err := rt.o.secrets.Resolve(rt.pid(), in.Env)
			if err != nil {
				return err.Error(), true, nil
			}
			ctx = local.WithExtraEnv(ctx, env)
			end := rt.trackSpan(ctx, a.ID, tools.ToolUseID(ctx), changes.SourceBash)
			defer end()
			out, isErr, err := next(ctx, input)
			return rt.redact(out), isErr, err
		}
	})
}

// guardWrite wraps a tool that writes one file (input: folder, path): newContent
// says what the file will hold (false: the tool will fail, so there is nothing
// to approve or record and it runs as is). The user is asked first in a
// supervised project, and the change is recorded exactly.
func (rt *runtime) guardWrite(reg *tools.Registry, a projectstore.Agent, tool string, newContent func(in json.RawMessage, abs string) (string, bool)) {
	reg.Decorate(tool, func(next tools.Handler) tools.Handler {
		return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			var in struct{ Folder, Path string }
			if json.Unmarshal(input, &in) != nil {
				return next(ctx, input)
			}
			f, ok := rt.folderOf(in.Folder)
			if !ok {
				return next(ctx, input)
			}
			rel := filepath.ToSlash(filepath.Clean(in.Path))
			abs, err := local.Resolve(f.Path, rel)
			if err != nil {
				return next(ctx, input)
			}
			content, ok := newContent(input, abs)
			if !ok {
				return next(ctx, input)
			}
			if ok, note := rt.approveWrite(ctx, a.ID, agentLabel(a), tool, f.Label, abs, rel, content); !ok {
				return denied(note), true, nil
			}
			t := rt.tracker()
			before := t.PreWrite(abs)
			out, isErr, err := next(ctx, input)
			if err != nil || isErr {
				return out, isErr, err
			}
			scope := rt.scope(a.ID, tools.ToolUseID(ctx), changes.SourceWriteFile)
			if _, recorded := t.PostWrite(ctx, scope, changes.Folder{Label: f.Label, Path: f.Path}, rel, before); !recorded {
				rt.publish(events.FileChanged, map[string]any{"folder": f.Label, "path": rel, "source": events.SourceAgent})
			}
			return out, isErr, err
		}
	})
}

// webFetchDef is the web_fetch tool of a project whose network setting is on:
// the user is asked first in a supervised project, secrets are kept out of the
// URL and the answer.
func (rt *runtime) webFetchDef(a projectstore.Agent) tools.Def {
	inner := webfetch.Handler(webfetch.Config{AllowPrivate: rt.info.NetworkPrivate, Redact: rt.redact})
	return tools.Def{
		Name: webfetch.Tool, Description: webfetch.Description, InputSchema: webfetch.Schema,
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			var in struct{ URL string }
			_ = json.Unmarshal(input, &in)
			if u, err := webfetch.ParseURL(in.URL); err == nil {
				if ok, note := rt.approveFetch(ctx, a.ID, agentLabel(a), u.String(), strings.ToLower(u.Hostname())); !ok {
					return denied(note), true, nil
				}
			}
			return inner(ctx, input)
		},
	}
}
