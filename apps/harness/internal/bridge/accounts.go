package bridge

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// AccountEditor adds, renames and removes the accounts of an agent (accounts.Service).
type AccountEditor interface {
	Add(agent, name, dir string) (accounts.Account, error)
	Rename(id, name string) (accounts.Account, error)
	Remove(id string, deleteData bool) (deletedDir string, err error)
}

// WithAccounts enables the agent account routes (they also need WithProviders).
func WithAccounts(a AccountEditor) Option { return func(s *Server) { s.accounts = a } }

func (s *Server) accountRoutes(mux *http.ServeMux) {
	if s.accounts == nil || s.providers == nil {
		return
	}
	mux.HandleFunc("POST /v1/providers/{base}/accounts", s.addAccount)
	mux.HandleFunc("PATCH /v1/providers/{id}/account", s.renameAccount)
	mux.HandleFunc("DELETE /v1/providers/{id}/account", s.removeAccount)
}

// provider is the entry of GET /v1/providers with this id.
func (s *Server) provider(id string) (providers.Provider, bool) {
	for _, p := range s.providers.Snapshot().Providers {
		if p.ID == id {
			return p, true
		}
	}
	return providers.Provider{}, false
}

func (s *Server) labelOf(id string) string {
	if p, ok := s.provider(id); ok && p.Label != "" {
		return p.Label
	}
	return id
}

// accountBody is the {account, provider} answer of an add or a rename.
func (s *Server) accountBody(acc accounts.Account) map[string]any {
	id := acc.Agent
	if acc.ID != "" {
		id = plugins.DerivedID(acc.Agent, acc.ID)
	}
	info := plugins.AccountInfo{ID: acc.ID, Name: acc.Name, Default: acc.ID == "", Dir: acc.Dir, Owned: acc.Owned}
	var prov any
	if p, ok := s.provider(id); ok {
		prov = p
	}
	return map[string]any{"account": info, "provider": prov}
}

// POST /v1/providers/{base}/accounts {"name", "dir"?}.
func (s *Server) addAccount(w http.ResponseWriter, r *http.Request) {
	base := r.PathValue("base")
	var in struct {
		Name string `json:"name"`
		Dir  string `json:"dir"`
	}
	if !decode(w, r, &in) {
		return
	}
	acc, err := s.accounts.Add(base, in.Name, in.Dir)
	if err != nil {
		s.accountError(w, err, base, in.Name)
		return
	}
	writeJSON(w, http.StatusCreated, s.accountBody(acc))
}

// PATCH /v1/providers/{id}/account {"name"}: a base id renames the default account.
func (s *Server) renameAccount(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	acc, err := s.accounts.Rename(id, in.Name)
	if err != nil {
		s.accountError(w, err, id, in.Name)
		return
	}
	writeJSON(w, http.StatusOK, s.accountBody(acc))
}

// DELETE /v1/providers/{id}/account?delete_data=bool.
func (s *Server) removeAccount(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	del := false
	if v := r.URL.Query().Get("delete_data"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeProblem(w, http.StatusBadRequest, usererr.AccountInvalid("delete_data must be true or false"))
			return
		}
		del = b
	}
	dir, err := s.accounts.Remove(id, del)
	if err != nil {
		s.accountError(w, err, id, "")
		return
	}
	var deleted any
	if dir != "" {
		deleted = dir
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": id, "deleted_dir": deleted})
}

func (s *Server) accountError(w http.ResponseWriter, err error, id, name string) {
	switch {
	case errors.Is(err, accounts.ErrFileUnusable):
		writeProblem(w, http.StatusConflict, usererr.AccountsFileUnusable(accounts.FileName, err.Error()))
	case errors.Is(err, accounts.ErrUnknownAgent):
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("agent"))
	case errors.Is(err, accounts.ErrUnsupported):
		base, _ := plugins.SplitID(id)
		reason := err.Error()
		if p, ok := s.provider(base); ok && p.AccountsSupport != nil && p.AccountsSupport.Reason != "" {
			reason = p.AccountsSupport.Reason
		}
		writeProblem(w, http.StatusConflict, usererr.AccountsUnsupported(s.labelOf(base), reason))
	case errors.Is(err, accounts.ErrNameTaken):
		writeProblem(w, http.StatusConflict, usererr.AccountNameTaken(name))
	case errors.Is(err, accounts.ErrDefault):
		writeProblem(w, http.StatusConflict, usererr.AccountDefault(s.labelOf(id)))
	case errors.Is(err, accounts.ErrInvalid):
		writeProblem(w, http.StatusBadRequest, usererr.AccountInvalid(err.Error()))
	default:
		slog.Error("account request failed", "agent", id, "err", err)
		writeProblem(w, http.StatusInternalServerError, usererr.Unexpected(err))
	}
}
