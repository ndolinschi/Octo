package terminal

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

const waitDelay = 2 * time.Second

// Spec describes an interactive shell session to launch.
type Spec struct {
	Name    string
	Folder  string
	Command string
	Args    []string
	Env     map[string]string
	Dir     string
	Cols    int
	Rows    int
}

type process struct {
	spec      Spec
	shell     string
	startedAt time.Time
	cmd       *exec.Cmd
	ptyMaster *os.File
	inW       *os.File
	outR      *os.File
	exited    chan struct{}
	code      int
}

// ResolveShell returns the interactive shell binary to execute when Spec.Command is empty.
func ResolveShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		if st, err := os.Stat(sh); err == nil && !st.IsDir() {
			return sh
		}
	}
	for _, cand := range defaultShellCandidates() {
		if path, err := exec.LookPath(cand); err == nil {
			return path
		}
	}
	return "/bin/sh"
}

func clampDims(cols, rows int) (uint16, uint16) {
	if cols <= 0 {
		cols = DefaultCols
	} else if cols > MaxCols {
		cols = MaxCols
	}
	if rows <= 0 {
		rows = DefaultRows
	} else if rows > MaxRows {
		rows = MaxRows
	}
	return uint16(cols), uint16(rows)
}

func startProcess(spec Spec) (*process, error) {
	command := spec.Command
	args := spec.Args
	if command == "" {
		command = ResolveShell()
	}
	spec.Command = command
	if spec.Name == "" {
		spec.Name = filepath.Base(command)
	}
	cols, rows := clampDims(spec.Cols, spec.Rows)
	spec.Cols, spec.Rows = int(cols), int(rows)

	extraEnv := map[string]string{
		"TERM":      "xterm-256color",
		"COLORTERM": "truecolor",
		"SHELL":     command,
	}
	for k, v := range spec.Env {
		extraEnv[k] = v
	}

	cmd := exec.Command(command, args...)
	cmd.Dir = spec.Dir
	cmd.Env = childenv.Build(os.Environ(), extraEnv)
	cmd.WaitDelay = waitDelay

	master, slave, ptyErr := openPTY(cols, rows)
	var inW, outR *os.File
	var closeInParent []*os.File
	if ptyErr == nil {
		attachPTY(cmd, slave)
		inW = master
		outR = master
		closeInParent = []*os.File{slave}
	} else {
		prIn, pwIn, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		prOut, pwOut, err := os.Pipe()
		if err != nil {
			_ = prIn.Close()
			_ = pwIn.Close()
			return nil, err
		}
		cmd.Stdin = prIn
		cmd.Stdout = pwOut
		cmd.Stderr = pwOut
		inW = pwIn
		outR = prOut
		closeInParent = []*os.File{prIn, pwOut}
	}

	if err := cmd.Start(); err != nil {
		for _, f := range closeInParent {
			_ = f.Close()
		}
		_ = inW.Close()
		if outR != inW {
			_ = outR.Close()
		}
		return nil, fmt.Errorf("start %s: %w", command, err)
	}
	for _, f := range closeInParent {
		_ = f.Close()
	}

	p := &process{
		spec:      spec,
		shell:     filepath.Base(command),
		startedAt: time.Now().UTC(),
		cmd:       cmd,
		ptyMaster: master,
		inW:       inW,
		outR:      outR,
		exited:    make(chan struct{}),
	}
	go func() {
		err := cmd.Wait()
		p.code = cmd.ProcessState.ExitCode()
		if err != nil {
			slog.Debug("terminal process ended", "shell", p.shell, "err", err)
		}
		_ = p.inW.Close()
		if p.outR != p.inW {
			_ = p.outR.Close()
		}
		close(p.exited)
	}()
	return p, nil
}

func (p *process) resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > MaxCols || rows > MaxRows {
		return ErrInvalidDimensions
	}
	return resizePTY(p.ptyMaster, uint16(cols), uint16(rows))
}

func (p *process) kill() {
	killProcessGroup(p.cmd)
	_ = p.inW.Close()
	if p.outR != p.inW {
		_ = p.outR.Close()
	}
}
