package fakeacp

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The scripted agent doubles as the CLI an ACP agent comes with, for the
// account flows of the harness (login and the login check):
//
//	fakeacp login   prints a URL line and a code line, waits for one input line,
//	                writes the file named by EnvLoginFile and exits 0
//	fakeacp status  exits 0 while that file exists, otherwise prints
//	                "Not logged in" and exits 1
//
// Both need EnvLoginFile, or EnvHome (the login file is then "login" in that
// folder: an account's folder variable); without either they exit 1 with a message.

const (
	// LoginURLLine is the line `fakeacp login` prints first.
	LoginURLLine = "Open this link to sign in: https://fakeacp.example/login?code=FAKE-1234"
	// LoginCodeLine is the line `fakeacp login` prints second.
	LoginCodeLine = "Your one-time code: FAKE-1234"
	// LoginPrompt is printed before the agent waits for the line.
	LoginPrompt = "Press Enter when you have signed in."
	// LoginDone is printed after the login file is written.
	LoginDone = "Signed in."
	// NotLoggedInLine is what `fakeacp status` prints when there is no login.
	NotLoggedInLine = "Not logged in"
)

// Prompt markers that make a turn fail the way an agent at its usage limit does.
const (
	// MarkerLimitRPC answers session/prompt with a JSON-RPC error whose data
	// carries errorKind "rate_limit" and rateLimit.resetsAt (RFC 3339), as the
	// Claude adapter does.
	MarkerLimitRPC = "[limit:rpc]"
	// MarkerLimitAgentError emits an agent_error update with HTTP status 429
	// and returns end_turn.
	MarkerLimitAgentError = "[limit:agent_error]"
)

// limitMessage is the text of both limit failures.
const limitMessage = "You've hit your usage limit."

// stopLimitRPC is the pseudo stop reason that makes the prompt fail with the limit RPC error.
const stopLimitRPC = "<limit-rpc>"

// limitResets is when the limit the markers report lifts: an hour from now.
func limitResets() string {
	return time.Now().Add(time.Hour).UTC().Truncate(time.Second).Format(time.RFC3339)
}

// limitRPCError is the JSON-RPC error of MarkerLimitRPC.
func limitRPCError() *rpcError {
	return &rpcError{Code: -32000, Message: limitMessage, Data: map[string]any{
		"errorKind": "rate_limit",
		"rateLimit": map[string]any{"resetsAt": limitResets()},
	}}
}

// limitAgentError emits the agent_error update of MarkerLimitAgentError.
func (a *agent) limitAgentError() {
	a.update(map[string]any{
		"sessionUpdate": "agent_error",
		"error": map[string]any{
			"name": "APIError",
			"data": map[string]any{"message": limitMessage, "statusCode": 429},
		},
	})
}

// cliCommand handles the `login` and `status` subcommands. done is false when
// args name neither, and the process serves ACP.
func cliCommand(ctx context.Context, args []string, in io.Reader, out, errOut io.Writer) (code int, done bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "login":
		return cliLogin(ctx, in, out, errOut), true
	case "status":
		return cliStatus(out, errOut), true
	}
	return 0, false
}

// cliLoginFile is the file `login` writes and `status` looks for.
func cliLoginFile() string {
	if f := os.Getenv(EnvLoginFile); f != "" {
		return f
	}
	if home := os.Getenv(EnvHome); home != "" {
		return filepath.Join(home, "login")
	}
	return ""
}

func cliLogin(ctx context.Context, in io.Reader, out, errOut io.Writer) int {
	file := cliLoginFile()
	if file == "" {
		fmt.Fprintln(errOut, "fakeacp: "+EnvLoginFile+" (or "+EnvHome+") is not set")
		return 1
	}
	fmt.Fprintln(out, LoginURLLine)
	fmt.Fprintln(out, LoginCodeLine)
	fmt.Fprintln(out, LoginPrompt)
	got := make(chan bool, 1)
	go func() { got <- bufio.NewScanner(in).Scan() }()
	select {
	case ok := <-got:
		if !ok {
			fmt.Fprintln(errOut, "fakeacp: no input")
			return 1
		}
	case <-ctx.Done():
		return 1
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		fmt.Fprintln(errOut, "fakeacp:", err)
		return 1
	}
	if err := os.WriteFile(file, []byte("signed in\n"), 0o600); err != nil {
		fmt.Fprintln(errOut, "fakeacp:", err)
		return 1
	}
	fmt.Fprintln(out, LoginDone)
	return 0
}

func cliStatus(out, errOut io.Writer) int {
	file := cliLoginFile()
	if file == "" {
		fmt.Fprintln(errOut, "fakeacp: "+EnvLoginFile+" (or "+EnvHome+") is not set")
		return 1
	}
	if _, err := os.Stat(file); err != nil {
		fmt.Fprintln(out, NotLoggedInLine)
		return 1
	}
	fmt.Fprintln(out, "Logged in")
	return 0
}

// reportValues says, for each variable of EnvReportValues, its value (or
// "unset"): a turn on an account shows which folder it saw.
func reportValues() string {
	names := splitList(os.Getenv(EnvReportValues))
	if len(names) == 0 {
		return ""
	}
	parts := make([]string, len(names))
	for i, n := range names {
		v, ok := os.LookupEnv(n)
		if !ok {
			v = "unset"
		}
		parts[i] = n + "=" + strings.TrimSpace(v)
	}
	return " Env values: " + strings.Join(parts, ", ") + "."
}
