package bridge

import (
	"net/http"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/features"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": Version})
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	d := s.svc.Defaults()
	caps := []string{}
	if s.router != nil && s.router.Enabled() {
		caps = s.router.Capabilities()
	}
	builtinOK, builtinWhy := s.builtinState()
	builtin := map[string]any{"available": builtinOK}
	if !builtinOK {
		builtin["reason"] = builtinWhy
	}
	defOrch := d.Models.Orchestrator
	if s.defaultOrch != nil {
		defOrch = s.defaultOrch()
	}
	var featSnap map[string]bool
	if s.features != nil {
		featSnap = s.features.Snapshot()
	} else {
		featSnap = features.NewStore(nil).Snapshot()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"builtin_loop": builtin, "default_orchestrator": defOrch,
		"default_models": d.Models, "default_max_depth": d.MaxDepth,
		"router": s.router != nil && s.router.Enabled(), "router_capabilities": caps,
		"route_api":         slices.Contains(caps, router.CapRouteAPI),
		"acp_orchestrators": s.acpOrchestrators(),
		"features":          featSnap,
		// Whether POST /v1/fs/pick-folder can open the system's folder chooser here.
		"pick_folder": pickFolderAvailable(),
	})
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.List(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": list})
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var in project.Input
	if !decode(w, r, &in) {
		return
	}
	p, err := s.svc.Create(r.Context(), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	p, err := s.svc.Get(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	var in project.Input
	if !decode(w, r, &in) {
		return
	}
	p, err := s.svc.Update(r.Context(), r.PathValue("pid"), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.Delete(r.Context(), r.PathValue("pid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.svc.Agents(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
}

func (s *Server) getAgent(w http.ResponseWriter, r *http.Request) {
	a, err := s.svc.Agent(r.Context(), r.PathValue("pid"), r.PathValue("aid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) agentMessages(w http.ResponseWriter, r *http.Request) {
	if sid := r.URL.Query().Get("session_id"); sid != "" {
		// One main session's part of the orchestrator's conversation (project sessions).
		if _, err := s.svc.Agent(r.Context(), r.PathValue("pid"), r.PathValue("aid")); err != nil {
			writeErr(w, err)
			return
		}
		out, err := s.svc.MessagesOfSession(r.Context(), r.PathValue("pid"), r.PathValue("aid"), sid)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	msgs, err := s.svc.Messages(r.Context(), r.PathValue("pid"), r.PathValue("aid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	marks, err := s.svc.Compactions(r.Context(), r.PathValue("pid"), r.PathValue("aid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	convs, err := s.svc.Conversations(r.Context(), r.PathValue("pid"), r.PathValue("aid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "compactions": marks, "conversations": convs})
}

func (s *Server) postMessage(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text        string   `json:"text"`
		Mode        *string  `json:"mode"`
		Attachments []string `json:"attachments"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.postSessionMessage(w, r, in.Text, in.Mode, in.Attachments)
}

// postSessionMessage sends a message to a main session ({sid}; none: the default): 202 {message}, or 202
// {queued, waiting_for} when it waits for the session's turn or for a slot.
func (s *Server) postSessionMessage(w http.ResponseWriter, r *http.Request, text string, mode *string, attachments []string) {
	msg, queued, err := s.svc.PostSessionMessage(r.Context(), r.PathValue("pid"), r.PathValue("sid"), text, mode, attachments)
	if err != nil {
		writeErr(w, err)
		return
	}
	if queued != nil {
		writeJSON(w, http.StatusAccepted, map[string]any{"queued": queued, "waiting_for": queued.WaitingFor})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"message": msg})
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.CancelSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"), r.URL.Query().Get("all") == "true"); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{})
}

func (s *Server) listNotes(w http.ResponseWriter, r *http.Request) {
	notes, err := s.notes.List(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	if err := s.notes.Delete(r.Context(), r.PathValue("pid"), r.PathValue("nid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) context(w http.ResponseWriter, r *http.Request) {
	if sid := r.PathValue("sid"); sid != "" {
		rep, err := s.svc.SessionContext(r.Context(), r.PathValue("pid"), sid)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rep)
		return
	}
	rep, err := s.svc.Context(r.Context(), r.PathValue("pid"), r.URL.Query().Get("agent"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// acpOrchestrator is one valid `acp:` setting for models.orchestrator or a tier.
type acpOrchestrator struct {
	// Value is the setting itself: "acp:<agent-id>".
	Value        string   `json:"value"`
	ID           string   `json:"id"`
	Label        string   `json:"label"`
	Models       []string `json:"models"`
	DefaultModel string   `json:"default_model,omitempty"`
}

// acpOrchestrators lists the available plugin agents as orchestrator choices.
func (s *Server) acpOrchestrators() []acpOrchestrator {
	out := []acpOrchestrator{}
	if s.plugins == nil {
		return out
	}
	for _, p := range s.plugins.Plugins() {
		for _, a := range p.Agents {
			if !a.Available {
				continue
			}
			models := a.Models
			if models == nil {
				models = []string{}
			}
			out = append(out, acpOrchestrator{
				Value: plugins.ACPPrefix + a.ID, ID: a.ID, Label: a.Label, Models: models, DefaultModel: a.DefaultModel,
			})
		}
	}
	return out
}
