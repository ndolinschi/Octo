package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func TestRecoverPanicReturns500JSON(t *testing.T) {
	s := &Server{}
	h := s.recoverPanic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/boom", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body %q: %v", rec.Body.String(), err)
	}
	if body.Error.Code != "internal" {
		t.Fatalf("error code = %q, want internal", body.Error.Code)
	}
}

func TestRecoverPanicAfterHeaderWritten(t *testing.T) {
	s := &Server{}
	h := s.recoverPanic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("partial"))
		panic("late boom")
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/partial", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if rec.Body.String() != "partial" {
		t.Fatalf("body = %q, want partial (no appended JSON)", rec.Body.String())
	}
}

func TestWriteErrUnmappedKindDefaultsTo500(t *testing.T) {
	rec := httptest.NewRecorder()
	writeErr(rec, &project.Error{Kind: project.Kind(999), Code: "weird", Message: "unmapped"})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
