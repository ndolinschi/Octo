package plugins

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// Limits of a models command: it is killed after ModelsCommandTimeout, only the
// first 64 KiB of its output are read, and at most maxCommandModels ids are kept.
const (
	ModelsCommandTimeout = 10 * time.Second
	maxCommandModels     = 100
)

// ModelsCommand is a manifest's `modelsCommand`: a program that prints the
// models of an agent, one per line.
type ModelsCommand struct {
	Command string // resolved path, or the manifest value when unresolved
	Args    []string
	// Pattern is matched against every output line; group 1 is the model id.
	Pattern *regexp.Regexp
	// LabelGroup is the group holding a display name (0: none).
	LabelGroup int
	Dir        string
}

// ListedModel is a model read from a models command.
type ListedModel struct {
	ID    string
	Label string
}

// ParseModels reads the models out of a command's output: lines that do not
// match the pattern, ids that are not valid model names and duplicates are
// ignored.
func (c ModelsCommand) ParseModels(out string) []ListedModel {
	var res []ListedModel
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		m := c.Pattern.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if len(m) < 2 {
			continue
		}
		id := strings.TrimSpace(m[1])
		if !ModelPattern.MatchString(id) || seen[id] || len(res) >= maxCommandModels {
			continue
		}
		seen[id] = true
		label := id
		if c.LabelGroup > 0 && c.LabelGroup < len(m) && strings.TrimSpace(m[c.LabelGroup]) != "" {
			label = strings.TrimSpace(m[c.LabelGroup])
		}
		res = append(res, ListedModel{ID: id, Label: label})
	}
	return res
}

// Run executes the command with the agent's child environment (the allow-list
// plus env), reading at most 64 KiB of stdout and stderr, and returns the models
// found. Failures are errors with a short message that never quotes the output.
func (c ModelsCommand) Run(ctx context.Context, env map[string]string) ([]ListedModel, error) {
	cctx, cancel := context.WithTimeout(ctx, ModelsCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, c.Command, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = childenv.Build(os.Environ(), env)
	cmd.WaitDelay = time.Second
	var out capped
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	got := c.ParseModels(string(out.b))
	var exit *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return nil, ctx.Err()
	case cctx.Err() != nil:
		return nil, fmt.Errorf("the models command timed out after %s", ModelsCommandTimeout)
	case err != nil && !errors.As(err, &exit):
		return nil, fmt.Errorf("the models command could not be started")
	case err != nil && len(got) == 0:
		return nil, fmt.Errorf("the models command failed (%v)", err)
	case len(got) == 0:
		return nil, fmt.Errorf("the models command printed no model its pattern recognises")
	}
	return got, nil
}
