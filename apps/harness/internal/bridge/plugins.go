package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func (s *Server) listPlugins(w http.ResponseWriter, r *http.Request) {
	list := []plugins.Plugin{}
	if s.plugins != nil {
		list = s.plugins.Plugins()
	}
	writeJSON(w, http.StatusOK, map[string]any{"plugins": list})
}
