package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (s *Server) slashCommands(w http.ResponseWriter, r *http.Request) {
	rep, err := s.svc.SlashCommands(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *Server) clearConversation(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.ClearSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// clearSessionConversation is POST /sessions/{sid}/clear: it answers like POST /sessions with clear (201
// {session}, the new session), plus the clear's result.
func (s *Server) clearSessionConversation(w http.ResponseWriter, r *http.Request) {
	out, err := s.svc.CreateSessionWith(r.Context(), r.PathValue("pid"), project.CreateSessionInput{FromSession: r.PathValue("sid"), Clear: true})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}
