package projectstore

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"modernc.org/sqlite"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Why a project's database cannot be used.
const (
	UnavailableNewer      = "newer_schema"
	UnavailableCorrupt    = "corrupt"
	UnavailableUnreadable = "unreadable"
)

// UnavailableError says one project's database cannot be opened: it is damaged,
// cannot be read, or was written by a newer version. The file is never changed,
// moved or deleted by the harness; the project is listed as unavailable and the
// other projects work. Its chain holds the catalogue case (usererr.As) and the
// cause (a *NewerSchemaError for a newer schema).
type UnavailableError struct {
	ID     string
	Path   string
	Reason string
	// Backups are the `.pre-*` copies the migrations left beside the file.
	Backups []string
	Err     error
	User    *usererr.Error
}

func (e *UnavailableError) Error() string {
	return e.User.Message + " (" + e.Path + ": " + e.Err.Error() + ")"
}

func (e *UnavailableError) Unwrap() []error { return []error{e.User, e.Err} }

// sqliteCode is the primary SQLite result code of err (0 when err is not one).
func sqliteCode(err error) int {
	var se *sqlite.Error
	if errors.As(err, &se) {
		return se.Code() & 0xff
	}
	return 0
}

// unavailableReason classifies an error of opening or reading a project's
// database; "" means it says nothing about the file (a cancelled request, a
// busy database) and is returned as it is.
func unavailableReason(err error) string {
	var ne *NewerSchemaError
	switch {
	case errors.As(err, &ne):
		return UnavailableNewer
	case errors.Is(err, fs.ErrPermission):
		return UnavailableUnreadable
	}
	switch sqliteCode(err) {
	case 11, 26: // SQLITE_CORRUPT, SQLITE_NOTADB
		return UnavailableCorrupt
	case 3, 8, 10, 14, 23: // PERM, READONLY, IOERR, CANTOPEN, AUTH
		return UnavailableUnreadable
	}
	return ""
}

// backupsOf lists the `.pre-*` copies beside the database file.
func backupsOf(path string) []string {
	m, _ := filepath.Glob(path + ".pre-*")
	sort.Strings(m)
	return m
}

// asUnavailable turns err into an *UnavailableError for the project id when it
// says the file cannot be used; any other error is returned unchanged.
func asUnavailable(id, path string, err error) error {
	var ue *UnavailableError
	if err == nil || errors.As(err, &ue) {
		return err
	}
	reason := unavailableReason(err)
	if reason == "" {
		return err
	}
	backups := backupsOf(path)
	details := path + ": " + err.Error()
	if len(backups) > 0 {
		details += ". Backups: " + strings.Join(backups, ", ")
	}
	var u *usererr.Error
	switch reason {
	case UnavailableNewer:
		u = usererr.NewerSchema(details)
	case UnavailableCorrupt:
		u = usererr.ProjectDamaged(len(backups) > 0, details)
	default:
		u = usererr.ProjectUnreadable(details)
	}
	return &UnavailableError{ID: id, Path: path, Reason: reason, Backups: backups, Err: err, User: u}
}

// Unavailable is the recorded reason project id cannot be opened, or nil.
func (s *Store) Unavailable(id string) *UnavailableError {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bad[id]
}

// Classify records err as the reason project id is unavailable when it says
// the database file cannot be used (damaged pages found after it opened), and
// closes the cached connection; it returns the error to report.
func (s *Store) Classify(id string, err error) error {
	err = asUnavailable(id, filepath.Join(s.projectDir(id), "project.sqlite"), err)
	var ue *UnavailableError
	if errors.As(err, &ue) {
		s.mu.Lock()
		s.bad[id] = ue
		if db, ok := s.dbs[id]; ok {
			_ = db.sql.Close()
			delete(s.dbs, id)
		}
		s.mu.Unlock()
	}
	return err
}

// Entry is a project's row in the registry (readable when its database is not).
func (s *Store) Entry(ctx context.Context, id string) (name, createdAt string, err error) {
	err = s.reg.QueryRowContext(ctx, `SELECT name, created_at FROM projects WHERE id = ?`, id).Scan(&name, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return name, createdAt, err
}

// RegistryError says the registry (the list of projects) cannot be opened.
// Nothing works without it; the harness stops with this.
type RegistryError struct {
	Path string
	Err  error
	User *usererr.Error
}

func (e *RegistryError) Error() string {
	return e.User.Message + " (" + e.Path + ": " + e.Err.Error() + ")"
}

func (e *RegistryError) Unwrap() []error { return []error{e.User, e.Err} }

func registryErr(path string, err error) error {
	var ne *NewerSchemaError
	if errors.As(err, &ne) {
		return &RegistryError{Path: path, Err: err, User: usererr.NewerSchema(path + ": " + err.Error())}
	}
	return &RegistryError{Path: path, Err: err, User: usererr.RegistryUnavailable(path, err.Error())}
}

// markBad classifies an open error; an unavailable project is remembered (the
// caller holds s.mu) so it is not opened again until the next start.
func (s *Store) markBad(id, path string, err error) error {
	err = asUnavailable(id, path, err)
	var ue *UnavailableError
	if errors.As(err, &ue) {
		s.bad[id] = ue
	}
	return err
}
