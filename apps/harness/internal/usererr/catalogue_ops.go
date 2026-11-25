package usererr

import "strings"

// Operational cases: a data file or a folder Octo cannot use (docs/errors.md, "Added 2026-11-19").
const (
	CodeProjectUnavailable  = "project_unavailable"
	CodeRegistryUnavailable = "registry_unavailable"
	CodeFolderMissing       = "folder_missing"
	CodeDataDirUnwritable   = "data_dir_unwritable"
)

// ProjectDamaged: a project's database is damaged (not a database, truncated,
// malformed). The file is left as it is; backup says a `.pre-*` copy exists
// beside it (its path is in details).
func ProjectDamaged(backup bool, details string) *Error {
	hint := "Octo left the file untouched. Restore it from your backup, or remove the project from Octo."
	if backup {
		hint = "Octo left the file untouched. A copy made before an update is beside it (see details); restore it, or remove the project."
	}
	return &Error{
		Code: CodeProjectUnavailable, Message: "This project's saved data is damaged, so Octo cannot open it.",
		Hint: hint, Details: clip(details),
	}
}

// ProjectUnreadable: a project's database cannot be opened or read (permissions, a missing file).
func ProjectUnreadable(details string) *Error {
	return &Error{
		Code: CodeProjectUnavailable, Message: "Octo cannot read this project's saved data.",
		Hint: "Check that the file in details exists and that you may read and write it, then restart Octo.", Details: clip(details),
	}
}

// RegistryUnavailable: the list of projects (registry.sqlite) cannot be opened; nothing starts.
func RegistryUnavailable(path, details string) *Error {
	return &Error{
		Code: CodeRegistryUnavailable, Message: "Octo cannot open its list of projects.",
		Hint:    "Octo left the file untouched. Restore it from a backup, or move it away to start with an empty list.",
		Details: clip(strings.TrimSpace(path + ": " + details)),
	}
}

// FolderMissing: a project folder is gone or cannot be read (moved, deleted, an unmounted disk).
func FolderMissing(label, path, details string) *Error {
	msg := "This project's folder is missing."
	if label != "" {
		msg = "The project folder " + label + " is missing."
	}
	return &Error{
		Code: CodeFolderMissing, Message: msg,
		Hint: "Put the folder back where it was, or remove it from the project in its settings.", Action: ActionOpenSettings,
		Details: clip(strings.TrimSpace(path + " " + details)),
	}
}

// DataDirUnwritable: the data folder cannot be written (a read-only disk, wrong owner).
func DataDirUnwritable(dir, details string) *Error {
	return &Error{
		Code: CodeDataDirUnwritable, Message: "Octo cannot write to its data folder.",
		Hint:    "Give your user write access to the folder in details, or start Octo with another data folder.",
		Details: clip(strings.TrimSpace(dir + ": " + details)),
	}
}
