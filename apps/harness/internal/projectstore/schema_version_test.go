package projectstore

import (
	"context"
	_ "embed"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// project_schema_20d4d6b.sql is the project schema of commit 20d4d6b, the
// release before approvals, changes, the queue and flat-rate usage.
//
//go:embed testdata/project_schema_20d4d6b.sql
var schema20d4d6b string

// seedPrevious writes a data dir as the previous release left it: a registry
// row and a project database with the old schema and some content.
func seedPrevious(t *testing.T, dir, id string) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.reg.ExecContext(ctx, `INSERT INTO projects (id, name, created_at) VALUES (?, 'old', ?)`, id, Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.reg.ExecContext(ctx, `PRAGMA user_version = 0`); err != nil { // the previous release did not stamp
		t.Fatal(err)
	}
	_ = s.Close()
	if err := os.MkdirAll(filepath.Join(dir, "projects", id), 0o755); err != nil {
		t.Fatal(err)
	}
	old, err := openSQLite(filepath.Join(dir, "projects", id, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	for _, q := range []string{
		schema20d4d6b,
		`INSERT INTO project (id, name, description, instructions, models_json, max_depth, created_at, updated_at) VALUES (1, 'old', '', '', '{}', 3, 't', 't')`,
		`INSERT INTO agents (id, depth, role, title, task, model, status, created_at) VALUES ('agt_1', 0, 'orchestrator', '', '', 'm', 'idle', 't')`,
		`INSERT INTO messages (agent_id, role, content_json, created_at) VALUES ('agt_1', 'user', '[{"type":"text","text":"hello"}]', 't')`,
		`INSERT INTO usage (agent_id, model, source, input_tokens, output_tokens, cost_usd, created_at) VALUES ('agt_1', 'm', 'acp', 10, 0, 0.5, 't')`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
}

func TestMigrateFromThePreviousSchemaKeepsEveryRow(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	seedPrevious(t, dir, "prj_old")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := s.Get(ctx, "prj_old")
	if err != nil {
		t.Fatalf("the previous release's project does not open: %v", err)
	}
	info, err := db.Info(ctx)
	if err != nil || info.Access != AccessFull {
		t.Fatalf("info = %+v %v: an existing project keeps full access", info, err)
	}
	msgs, err := db.Messages(ctx, "agt_1")
	if err != nil || len(msgs) != 1 {
		t.Fatalf("messages = %v %v", msgs, err)
	}
	log, err := db.UsageLog(ctx)
	if err != nil || len(log) != 1 || log[0].FlatRate || log[0].CostUSD == nil || *log[0].CostUSD != 0.5 {
		t.Fatalf("usage = %+v %v", log, err)
	}
	// The new tables work on the migrated database.
	if _, err := db.Enqueue(ctx, "hi"); err != nil {
		t.Fatal(err)
	}
	if turns, err := db.Changes(ctx, 0); err != nil || len(turns) != 0 {
		t.Fatalf("changes = %v %v", turns, err)
	}
	if v, err := userVersion(ctx, db.sql); err != nil || v != SchemaVersion {
		t.Fatalf("user_version = %d %v, want %d", v, err, SchemaVersion)
	}
	// And it stays openable: a second open is a no-op migration.
	_ = s.Close()
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if _, err := s2.Get(ctx, "prj_old"); err != nil {
		t.Fatal(err)
	}
}

func TestNewerProjectDatabaseIsRefusedAndLeftUntouched(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	seedPrevious(t, dir, "prj_new")
	path := filepath.Join(dir, "projects", "prj_new", "project.sqlite")
	raw, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, err = s.Get(ctx, "prj_new")
	var ne *NewerSchemaError
	if !errors.As(err, &ne) || ne.Version != 99 || !strings.Contains(err.Error(), "newer version of the app") || !strings.Contains(err.Error(), "update the app") {
		t.Fatalf("err = %v, want a clear newer-schema refusal", err)
	}
	// Not touched: no new tables were added by the refused open.
	raw, err = openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var n int
	if err := raw.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'changes'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("the refused database was modified (changes table: %d, %v)", n, err)
	}
}

func TestNewerRegistryIsRefused(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.reg.Exec(`PRAGMA user_version = 42`); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	_, err = Open(dir)
	var ne *NewerSchemaError
	if !errors.As(err, &ne) || ne.Version != 42 {
		t.Fatalf("err = %v", err)
	}
}
