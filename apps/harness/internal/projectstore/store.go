package projectstore

import (
	"context"
	"crypto/rand"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

const registrySchema = `
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL
);`

// Store is the registry index plus a cache of open per-project databases.
type Store struct {
	dir string
	reg *sql.DB

	mu  sync.Mutex
	dbs map[string]*DB
	// bad holds the projects whose database cannot be opened (unavailable.go).
	bad map[string]*UnavailableError
}

func Open(dataDir string) (*Store, error) {
	absDir, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(absDir, "projects"), privateDir); err != nil {
		return nil, err
	}
	// Data written by an older version, or under a wide umask, is closed to other users at every start.
	tightenTree(absDir, 3)
	regPath := filepath.Join(absDir, "registry.sqlite")
	reg, err := openSQLite(regPath)
	if err != nil {
		return nil, registryErr(regPath, err)
	}
	if err := checkVersion(context.Background(), reg, regPath); err != nil {
		_ = reg.Close()
		return nil, registryErr(regPath, err)
	}
	if _, err := reg.Exec(registrySchema); err != nil {
		_ = reg.Close()
		return nil, registryErr(regPath, err)
	}
	// Read the whole list once, so a damaged registry is found here and not by the first request.
	var n int
	if err := reg.QueryRow(`SELECT count(*) FROM projects`).Scan(&n); err != nil {
		_ = reg.Close()
		return nil, registryErr(regPath, err)
	}
	if err := stampVersion(context.Background(), reg); err != nil {
		_ = reg.Close()
		return nil, registryErr(regPath, err)
	}
	return &Store{dir: absDir, reg: reg, dbs: make(map[string]*DB), bad: make(map[string]*UnavailableError)}, nil
}

// openSQLite opens one serialized connection: WAL, busy timeout, and a single
// writer so parallel agents never see SQLITE_BUSY from this process.
func openSQLite(path string) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uriPath := filepath.ToSlash(abs)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := url.URL{
		Scheme:   "file",
		Path:     uriPath,
		RawQuery: "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)",
	}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	makeSQLitePrivate(abs)
	return db, nil
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var first error
	for id, db := range s.dbs {
		if err := db.sql.Close(); err != nil && first == nil {
			first = err
		}
		delete(s.dbs, id)
	}
	if err := s.reg.Close(); err != nil && first == nil {
		first = err
	}
	return first
}

// ProjectDir is the data directory of a project (project.sqlite and files beside it).
func (s *Store) ProjectDir(id string) string { return s.projectDir(id) }

func (s *Store) projectDir(id string) string {
	return filepath.Join(s.dir, "projects", id)
}

// Create makes the project directory, database, orchestrator agent and registry row.
func (s *Store) Create(ctx context.Context, in NewProject) (*DB, error) {
	id := NewID("prj")
	if err := os.MkdirAll(s.projectDir(id), privateDir); err != nil {
		return nil, err
	}
	db, err := s.open(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := db.init(ctx, in); err != nil {
		s.drop(id)
		_ = os.RemoveAll(s.projectDir(id))
		return nil, err
	}
	_, err = s.reg.ExecContext(ctx, `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, id, in.Name, Now())
	if err != nil {
		s.drop(id)
		_ = os.RemoveAll(s.projectDir(id))
		return nil, err
	}
	return db, nil
}

// Get returns the open database for a registered project.
func (s *Store) Get(ctx context.Context, id string) (*DB, error) {
	var found string
	err := s.reg.QueryRowContext(ctx, `SELECT id FROM projects WHERE id = ?`, id).Scan(&found)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.open(ctx, id)
}

func (s *Store) open(ctx context.Context, id string) (*DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if db, ok := s.dbs[id]; ok {
		return db, nil
	}
	if ue := s.bad[id]; ue != nil {
		return nil, ue
	}
	path := filepath.Join(s.projectDir(id), "project.sqlite")
	sdb, err := openSQLite(path)
	if err != nil {
		return nil, s.markBad(id, path, err)
	}
	db := &DB{id: id, sql: sdb, dir: s.projectDir(id)}
	if err := db.migrate(ctx); err != nil {
		_ = sdb.Close()
		return nil, s.markBad(id, path, err)
	}
	s.dbs[id] = db
	return db, nil
}

// Evict closes the cached database of a project; the next Get reopens it.
func (s *Store) Evict(id string) { s.drop(id) }

func (s *Store) drop(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if db, ok := s.dbs[id]; ok {
		_ = db.sql.Close()
		delete(s.dbs, id)
	}
}

func (s *Store) IDs(ctx context.Context) ([]string, error) {
	rows, err := s.reg.QueryContext(ctx, `SELECT id FROM projects ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) Rename(ctx context.Context, id, name string) error {
	_, err := s.reg.ExecContext(ctx, `UPDATE projects SET name = ? WHERE id = ?`, name, id)
	return err
}

// Has reports whether id is registered in the project index without opening project.sqlite.
func (s *Store) Has(ctx context.Context, id string) (bool, error) {
	var found string
	err := s.reg.QueryRowContext(ctx, `SELECT id FROM projects WHERE id = ?`, id).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// Delete removes the registry row and the project directory.
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.reg.ExecContext(ctx, `DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	s.drop(id)
	s.mu.Lock()
	delete(s.bad, id)
	s.mu.Unlock()
	dir := s.projectDir(id)
	makeWritableTree(dir)
	return os.RemoveAll(dir)
}

func makeWritableTree(root string) {
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		mode := info.Mode()
		if mode&os.ModeSymlink != 0 {
			return nil
		}
		want := mode.Perm() | 0o200
		if d.IsDir() {
			want |= 0o700
		}
		if mode.Perm() != want {
			_ = os.Chmod(path, want)
		}
		return nil
	})
}

func NewID(prefix string) string {
	return prefix + "_" + strings.ToLower(rand.Text()[:16])
}
