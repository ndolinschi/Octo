package projectstore

import (
	"os"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Missing is the catalogue case for a project folder that is gone, is not a
// folder, or cannot be read (moved away, an unmounted disk); nil when it is
// usable. Terminals, Processes runs, turns and the file routes check it before
// they start anything there, so the person reads which folder and what to do
// instead of a shell's "fork/exec /bin/bash: no such file or directory".
func (f Folder) Missing() *usererr.Error {
	fi, err := os.Stat(f.Path)
	if err != nil {
		return usererr.FolderMissing(f.Label, f.Path, err.Error())
	}
	if !fi.IsDir() {
		return usererr.FolderMissing(f.Label, f.Path, "is not a folder")
	}
	d, err := os.Open(f.Path)
	if err != nil {
		return usererr.FolderMissing(f.Label, f.Path, err.Error())
	}
	_ = d.Close()
	return nil
}

// MissingFolder is the case of the first missing folder of the list, or nil.
func MissingFolder(folders []Folder) *usererr.Error {
	for _, f := range folders {
		if u := f.Missing(); u != nil {
			return u
		}
	}
	return nil
}
