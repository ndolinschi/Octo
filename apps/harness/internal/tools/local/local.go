package local

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	ToolBash      = "bash"
	ToolReadFile  = "read_file"
	ToolWriteFile = "write_file"
	ToolListDir   = "list_dir"
)

// Root is a labelled directory that file and shell tools are confined to.
type Root struct {
	Label string
	Path  string
}

// AllTools lists every tool RegisterRoots can provide.
var AllTools = []string{ToolBash, ToolReadFile, ToolWriteFile, ToolListDir}

const folderProp = `"folder":{"type":"string","description":"Folder label; defaults to the first folder"}`

func schemaFor(tool string, multi bool) json.RawMessage {
	props := map[string]string{
		ToolBash:      `"command":{"type":"string","description":"Shell command to run"}`,
		ToolReadFile:  `"path":{"type":"string","description":"Relative path under the folder"}`,
		ToolWriteFile: `"path":{"type":"string","description":"Relative path under the folder"},"content":{"type":"string","description":"File contents"}`,
		ToolListDir:   `"path":{"type":"string","description":"Relative directory path; defaults to the folder root"}`,
	}
	required := map[string]string{
		ToolBash:      `["command"]`,
		ToolReadFile:  `["path"]`,
		ToolWriteFile: `["path","content"]`,
		ToolListDir:   `[]`,
	}
	p := props[tool]
	if multi {
		p += "," + folderProp
	}
	return json.RawMessage(`{"type":"object","properties":{` + p + `},"required":` + required[tool] + `}`)
}

var descriptions = map[string]string{
	ToolBash:      "Run a shell command in a project folder",
	ToolReadFile:  "Read a text file under a project folder",
	ToolWriteFile: "Write a text file under a project folder",
	ToolListDir:   "List a directory under a project folder",
}

// Register installs all four tools over a single workspace.
func Register(reg *tools.Registry, workspace string) error {
	return RegisterRoots(reg, []Root{{Label: "workspace", Path: workspace}}, AllTools...)
}

// RegisterRoots installs the named tools (all when none are named) over roots.
// With no roots nothing is registered.
func RegisterRoots(reg *tools.Registry, roots []Root, names ...string) error {
	if len(roots) == 0 {
		return nil
	}
	if len(names) == 0 {
		names = AllTools
	}
	rs, err := newRootSet(roots)
	if err != nil {
		return err
	}
	handlers := map[string]tools.Handler{
		ToolBash:      bashHandler(rs),
		ToolReadFile:  readFileHandler(rs),
		ToolWriteFile: writeFileHandler(rs),
		ToolListDir:   listDirHandler(rs),
	}
	for _, name := range names {
		h, ok := handlers[name]
		if !ok {
			return fmt.Errorf("local: unknown tool %q", name)
		}
		err := reg.Register(tools.Def{
			Name:        name,
			Description: descriptions[name],
			InputSchema: schemaFor(name, len(roots) > 1),
			Handle:      h,
		})
		if err != nil {
			return err
		}
	}
	return nil
}

type rootSet struct {
	roots []Root
}

func newRootSet(roots []Root) (*rootSet, error) {
	out := make([]Root, 0, len(roots))
	for _, r := range roots {
		abs, err := filepath.Abs(r.Path)
		if err != nil {
			return nil, fmt.Errorf("folder %q: %w", r.Label, err)
		}
		out = append(out, Root{Label: r.Label, Path: abs})
	}
	return &rootSet{roots: out}, nil
}

// pick returns the root path for a folder label; empty selects the first root.
func (s *rootSet) pick(label string) (string, error) {
	if label == "" {
		return s.roots[0].Path, nil
	}
	for _, r := range s.roots {
		if r.Label == label {
			return r.Path, nil
		}
	}
	return "", fmt.Errorf("unknown folder %q", label)
}

func (s *rootSet) resolve(folder, rel string) (root, abs string, err error) {
	root, err = s.pick(folder)
	if err != nil {
		return "", "", err
	}
	abs, err = resolveUnderWorkspace(root, rel)
	return root, abs, err
}
