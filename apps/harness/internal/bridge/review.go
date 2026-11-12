package bridge

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/review"
)

// WithReviews serves the pull-request review API (RV1). Without it the routes
// answer 404 "no such route".
func WithReviews(svc *review.Service) Option { return func(s *Server) { s.reviews = svc } }

// reviewRoutes registers the review API. The submit route is the only way a
// review is posted to a code host; it is an ordinary HTTP route and is not
// offered to agents (no tool, no MCP tool calls it).
func (s *Server) reviewRoutes(mux *http.ServeMux) {
	if s.reviews == nil {
		return
	}
	mux.HandleFunc("GET /v1/projects/{pid}/prs", s.listPRs)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews", s.listReviews)
	mux.HandleFunc("POST /v1/projects/{pid}/reviews", s.openReview)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews/{rid}", s.getReview)
	mux.HandleFunc("PATCH /v1/projects/{pid}/reviews/{rid}", s.patchReview)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews/{rid}/files", s.reviewFiles)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews/{rid}/files/{path...}", s.reviewFile)
	mux.HandleFunc("PATCH /v1/projects/{pid}/reviews/{rid}/files/{path...}", s.reviewFileViewed)
	mux.HandleFunc("POST /v1/projects/{pid}/reviews/{rid}/checkout", s.checkoutReview)
	mux.HandleFunc("DELETE /v1/projects/{pid}/review-workspace", s.clearReviewWorkspace)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews/{rid}/threads", s.reviewThreads)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews/{rid}/comments", s.listReviewComments)
	mux.HandleFunc("POST /v1/projects/{pid}/reviews/{rid}/comments", s.createReviewComment)
	mux.HandleFunc("PATCH /v1/projects/{pid}/reviews/{rid}/comments/{cid}", s.updateReviewComment)
	mux.HandleFunc("DELETE /v1/projects/{pid}/reviews/{rid}/comments/{cid}", s.deleteReviewComment)
	mux.HandleFunc("GET /v1/projects/{pid}/reviews/{rid}/findings", s.listReviewFindings)
	mux.HandleFunc("PATCH /v1/projects/{pid}/reviews/{rid}/findings/{fid}", s.decideReviewFinding)
	mux.HandleFunc("POST /v1/projects/{pid}/reviews/{rid}/submit-preview", s.previewReviewSubmit)
	mux.HandleFunc("POST /v1/projects/{pid}/reviews/{rid}/submit", s.submitReview)
}

func writeReviewErr(w http.ResponseWriter, err error) {
	var re *review.Error
	if errors.As(err, &re) {
		status := map[review.Kind]int{
			review.KindInvalid:     http.StatusBadRequest,
			review.KindNotFound:    http.StatusNotFound,
			review.KindConflict:    http.StatusConflict,
			review.KindTooLarge:    http.StatusRequestEntityTooLarge,
			review.KindUpstream:    http.StatusBadGateway,
			review.KindUnsupported: http.StatusUnsupportedMediaType,
		}[re.Kind]
		body := map[string]any{"code": re.Code, "message": re.Message}
		if re.Command != "" {
			body["command"] = re.Command
		}
		if len(re.Files) > 0 {
			body["files"] = re.Files
		}
		writeJSON(w, status, map[string]any{"error": body})
		return
	}
	writeErr(w, err)
}

func (s *Server) listPRs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	o := review.ListOptions{Folder: q.Get("folder"), Filter: q.Get("filter"), Q: q.Get("q"),
		Refresh: q.Get("refresh") == "1" || q.Get("refresh") == "true"}
	for name, dst := range map[string]*int{"page": &o.Page, "per_page": &o.PerPage} {
		if v := q.Get(name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				writeError(w, http.StatusBadRequest, "invalid_request", name+" must be a positive integer")
				return
			}
			*dst = n
		}
	}
	out, err := s.reviews.ListPRs(r.Context(), r.PathValue("pid"), o)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listReviews(w http.ResponseWriter, r *http.Request) {
	list, err := s.reviews.List(r.Context(), r.PathValue("pid"), r.URL.Query().Get("state"))
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviews": list})
}

func (s *Server) openReview(w http.ResponseWriter, r *http.Request) {
	var in review.OpenRequest
	if !decode(w, r, &in) {
		return
	}
	v, created, err := s.reviews.Open(r.Context(), r.PathValue("pid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, v)
}

func (s *Server) getReview(w http.ResponseWriter, r *http.Request) {
	v, err := s.reviews.Get(r.Context(), r.PathValue("pid"), r.PathValue("rid"))
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) patchReview(w http.ResponseWriter, r *http.Request) {
	var in review.PatchRequest
	if !decode(w, r, &in) {
		return
	}
	v, err := s.reviews.Patch(r.Context(), r.PathValue("pid"), r.PathValue("rid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) reviewFiles(w http.ResponseWriter, r *http.Request) {
	out, err := s.reviews.Files(r.Context(), r.PathValue("pid"), r.PathValue("rid"))
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// reviewFile serves the hunks of one file (JSON), or with ?raw=new|old the
// file's bytes at the head or the base (images next to their diff).
func (s *Server) reviewFile(w http.ResponseWriter, r *http.Request) {
	pid, rid, p := r.PathValue("pid"), r.PathValue("rid"), r.PathValue("path")
	q := r.URL.Query()
	if raw := q.Get("raw"); raw != "" {
		b, ct, err := s.reviews.Raw(r.Context(), pid, rid, p, raw)
		if err != nil {
			writeReviewErr(w, err)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// A repository's file is untrusted: never let a browser run it.
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
		w.Header().Set("Content-Disposition", "inline")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
		return
	}
	o := review.DiffOptions{IgnoreWhitespace: q.Get("ignore_whitespace") == "1" || q.Get("ignore_whitespace") == "true", Since: q.Get("since")}
	if v := q.Get("context"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "context must be a non-negative integer")
			return
		}
		o.Context = n
	}
	out, err := s.reviews.FileDiff(r.Context(), pid, rid, p, o)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) reviewFileViewed(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Viewed *bool `json:"viewed"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Viewed == nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "viewed (true or false) is required")
		return
	}
	f, err := s.reviews.SetViewed(r.Context(), r.PathValue("pid"), r.PathValue("rid"), r.PathValue("path"), *in.Viewed)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// checkoutReview checks a pull request out: into the review workspace (the
// project's file tree and editor point at its worktree) or into the project's
// own folder as a local branch.
func (s *Server) checkoutReview(w http.ResponseWriter, r *http.Request) {
	var in review.CheckoutRequest
	if !decode(w, r, &in) {
		return
	}
	out, err := s.reviews.Checkout(r.Context(), r.PathValue("pid"), r.PathValue("rid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// clearReviewWorkspace points the project back at its own folders.
func (s *Server) clearReviewWorkspace(w http.ResponseWriter, r *http.Request) {
	if err := s.reviews.ClearWorkspace(r.Context(), r.PathValue("pid")); err != nil {
		writeReviewErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// reviewThreads serves the review threads the code host already has (read only;
// ?refresh=1 asks the host again).
func (s *Server) reviewThreads(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "1" || r.URL.Query().Get("refresh") == "true"
	out, err := s.reviews.Threads(r.Context(), r.PathValue("pid"), r.PathValue("rid"), refresh)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listReviewComments(w http.ResponseWriter, r *http.Request) {
	list, err := s.reviews.Comments(r.Context(), r.PathValue("pid"), r.PathValue("rid"))
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": list})
}

func (s *Server) createReviewComment(w http.ResponseWriter, r *http.Request) {
	var in review.CommentInput
	if !decode(w, r, &in) {
		return
	}
	c, err := s.reviews.CreateComment(r.Context(), r.PathValue("pid"), r.PathValue("rid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) updateReviewComment(w http.ResponseWriter, r *http.Request) {
	var in review.CommentUpdate
	if !decode(w, r, &in) {
		return
	}
	c, err := s.reviews.UpdateComment(r.Context(), r.PathValue("pid"), r.PathValue("rid"), r.PathValue("cid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) deleteReviewComment(w http.ResponseWriter, r *http.Request) {
	if err := s.reviews.DeleteComment(r.Context(), r.PathValue("pid"), r.PathValue("rid"), r.PathValue("cid")); err != nil {
		writeReviewErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listReviewFindings(w http.ResponseWriter, r *http.Request) {
	list, err := s.reviews.Findings(r.Context(), r.PathValue("pid"), r.PathValue("rid"))
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": list})
}

func (s *Server) decideReviewFinding(w http.ResponseWriter, r *http.Request) {
	var in review.FindingDecision
	if !decode(w, r, &in) {
		return
	}
	out, err := s.reviews.DecideFinding(r.Context(), r.PathValue("pid"), r.PathValue("rid"), r.PathValue("fid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) previewReviewSubmit(w http.ResponseWriter, r *http.Request) {
	var in review.SubmitRequest
	if !decode(w, r, &in) {
		return
	}
	out, err := s.reviews.SubmitPreview(r.Context(), r.PathValue("pid"), r.PathValue("rid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) submitReview(w http.ResponseWriter, r *http.Request) {
	var in review.SubmitRequest
	if !decode(w, r, &in) {
		return
	}
	out, err := s.reviews.Submit(r.Context(), r.PathValue("pid"), r.PathValue("rid"), in)
	if err != nil {
		writeReviewErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
