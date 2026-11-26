package bridge

import (
	"errors"
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// WithAccounts serves POST /v1/providers/{id}/accounts and
// DELETE /v1/providers/{id}/accounts/{account}: more logins of an agent, each
// listed by GET /v1/providers as an agent of its own ("<id>@<account>").
func WithAccounts(a *accounts.Service) Option { return func(s *Server) { s.accounts = a } }

// POST /v1/providers/{id}/accounts {"label", "config_dir", "id"?}: add an
// account; answers 201 with the account's providers entry, its login checked.
func (s *Server) addAccount(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID        string `json:"id"`
		Label     string `json:"label"`
		ConfigDir string `json:"config_dir"`
	}
	if !decode(w, r, &in) {
		return
	}
	agent := r.PathValue("id")
	p, err := s.accounts.Add(r.Context(), agent, plugins.Account{ID: in.ID, Label: in.Label, ConfigDir: in.ConfigDir})
	if err != nil {
		s.accountError(w, agent, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

// DELETE /v1/providers/{id}/accounts/{account}: forget an account (its folder
// and the login in it stay on disk).
func (s *Server) removeAccount(w http.ResponseWriter, r *http.Request) {
	agent := r.PathValue("id")
	if err := s.accounts.Remove(agent, r.PathValue("account")); err != nil {
		s.accountError(w, agent, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) accountError(w http.ResponseWriter, agent string, err error) {
	var inv *accounts.InvalidError
	switch {
	case errors.Is(err, accounts.ErrUnknownAgent):
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("agent"))
	case errors.Is(err, accounts.ErrNotSupported):
		writeProblem(w, http.StatusBadRequest, usererr.AccountsNotSupported(s.accounts.Label(agent)))
	case errors.Is(err, accounts.ErrTaken):
		writeProblem(w, http.StatusConflict, usererr.AccountTaken())
	case errors.Is(err, accounts.ErrFull):
		writeProblem(w, http.StatusBadRequest, usererr.AccountsFull(accounts.MaxPerAgent))
	case errors.Is(err, accounts.ErrNotFound):
		writeProblem(w, http.StatusNotFound, usererr.AccountGone())
	case errors.As(err, &inv) && inv.Field == "config_dir":
		writeProblem(w, http.StatusBadRequest, usererr.AccountFolderInvalid().WithDetails(inv.Error()))
	case errors.As(err, &inv):
		writeProblem(w, http.StatusBadRequest, usererr.AccountNameInvalid(accounts.MaxLabelLen).WithDetails(inv.Error()))
	default:
		s.providerError(w, err)
	}
}
