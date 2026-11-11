package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
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
	writeJSON(w, http.StatusOK, map[string]any{
		"default_models": d.Models, "default_max_depth": d.MaxDepth,
		"router": s.router != nil && s.router.Enabled(), "router_capabilities": caps,
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
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "compactions": marks})
}

func (s *Server) postMessage(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &in) {
		return
	}
	msg, err := s.svc.PostMessage(r.Context(), r.PathValue("pid"), in.Text)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"message": msg})
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.Cancel(r.Context(), r.PathValue("pid")); err != nil {
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

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if !decode(w, r, &in) {
		return
	}
	n, err := s.notes.Create(r.Context(), r.PathValue("pid"), in.Title, in.Content)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) updateNote(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title   *string `json:"title"`
		Content *string `json:"content"`
	}
	if !decode(w, r, &in) {
		return
	}
	n, err := s.notes.Update(r.Context(), r.PathValue("pid"), r.PathValue("nid"), in.Title, in.Content)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	if err := s.notes.Delete(r.Context(), r.PathValue("pid"), r.PathValue("nid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) context(w http.ResponseWriter, r *http.Request) {
	rep, err := s.svc.Context(r.Context(), r.PathValue("pid"), r.URL.Query().Get("agent"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}
