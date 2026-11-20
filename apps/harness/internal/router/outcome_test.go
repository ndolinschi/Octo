package router_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func outcomeServer(t *testing.T, caps string, h http.HandlerFunc) *router.Router {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"service":"octo","capabilities":` + caps + `}`))
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return router.New(context.Background(), srv.URL+"/autoroute", "okey", router.WithOutcomeBackoff(5*time.Millisecond))
}

func TestReportOutcomePostsTheReportWithTheClientKey(t *testing.T) {
	var path, key string
	var body map[string]any
	r := outcomeServer(t, `["route_outcome"]`, func(w http.ResponseWriter, req *http.Request) {
		path, key = req.URL.Path, req.Header.Get("x-octo-key")
		_ = json.NewDecoder(req.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"stored":true,"solved":"no","rule":"tests_failed","confidence":"medium"}`))
	})
	ack, err := r.ReportOutcome(context.Background(), "octo_1", router.Outcome{
		ReportID: "a:finished", Event: router.EventFinished, Status: router.StatusCompleted, AgentSignal: router.SignalDone,
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/autoroute/v1/route/octo_1/outcome" || key != "okey" {
		t.Fatalf("path %q key %q", path, key)
	}
	if body["event"] != "finished" || body["status"] != "completed" || body["report_id"] != "a:finished" || body["at"] == "" {
		t.Fatalf("body = %+v", body)
	}
	if !ack.Stored || ack.Solved != "no" || ack.Rule != "tests_failed" {
		t.Fatalf("ack = %+v", ack)
	}
}

func TestReportOutcomeRetriesA404OrA5xxAtMostThreeTimes(t *testing.T) {
	var n atomic.Int32
	r := outcomeServer(t, `["route_outcome"]`, func(w http.ResponseWriter, req *http.Request) {
		if n.Add(1) < 3 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"stored":true,"solved":"yes","rule":"completed"}`))
	})
	if _, err := r.ReportOutcome(context.Background(), "octo_1", router.Outcome{ReportID: "x", Event: router.EventRewound}); err != nil || n.Load() != 3 {
		t.Fatalf("err %v after %d attempts", err, n.Load())
	}
	n.Store(0)
	down := outcomeServer(t, `["route_outcome"]`, func(w http.ResponseWriter, req *http.Request) {
		n.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	})
	if _, err := down.ReportOutcome(context.Background(), "octo_1", router.Outcome{ReportID: "x", Event: router.EventRewound}); err == nil || n.Load() != 3 {
		t.Fatalf("err %v after %d attempts", err, n.Load())
	}
	n.Store(0)
	bad := outcomeServer(t, `["route_outcome"]`, func(w http.ResponseWriter, req *http.Request) {
		n.Add(1)
		w.WriteHeader(http.StatusUnprocessableEntity)
	})
	if _, err := bad.ReportOutcome(context.Background(), "octo_1", router.Outcome{ReportID: "x", Event: router.EventRewound}); err == nil || n.Load() != 1 {
		t.Fatalf("a 422 was retried: err %v, %d attempts", err, n.Load())
	}
}

func TestOutcomesAreNotSentToARouterWithoutTheCapability(t *testing.T) {
	var n atomic.Int32
	r := outcomeServer(t, `["route_api"]`, func(w http.ResponseWriter, req *http.Request) { n.Add(1) })
	if _, err := r.ReportOutcome(context.Background(), "octo_1", router.Outcome{ReportID: "x", Event: router.EventRewound}); err == nil {
		t.Fatal("no error without route_outcome")
	}
	r.SendOutcome("octo_1", router.Outcome{ReportID: "x", Event: router.EventRewound})
	r.WaitOutcomes()
	var nilRouter *router.Router
	nilRouter.SendOutcome("octo_1", router.Outcome{})
	nilRouter.WaitOutcomes()
	if n.Load() != 0 {
		t.Fatalf("requests = %d", n.Load())
	}
}

func TestSendOutcomeDoesNotBlockTheCaller(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var got []string
	r := outcomeServer(t, `["route_outcome"]`, func(w http.ResponseWriter, req *http.Request) {
		<-release
		mu.Lock()
		got = append(got, req.URL.Path)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"stored":true}`))
	})
	start := time.Now()
	r.SendOutcome("octo_9", router.Outcome{ReportID: "x", Event: router.EventReverted})
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("SendOutcome blocked")
	}
	close(release)
	r.WaitOutcomes()
	if len(got) != 1 {
		t.Fatalf("got %v", got)
	}
}
