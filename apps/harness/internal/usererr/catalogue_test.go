package usererr

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode"
)

// samples builds every constructor of the catalogue with sample arguments.
// TestEveryConstructorIsListed fails when a constructor is missing here, so
// a new case cannot skip the wording rules.
func samples() map[string]*Error {
	const long = "exit status 1: acp initialize: JSON-RPC session/new failed (stderr: boom)"
	return map[string]*Error{
		"AgentNotLoggedIn":       AgentNotLoggedIn("GitHub Copilot", "copilot login", long),
		"AgentNotInstalled":      AgentNotInstalled("GitHub Copilot", "npm install -g @github/copilot", long),
		"AgentLaunchRejected":    AgentLaunchRejected("Antigravity", "agy", "unexpected argument 'acp'", "Update agy."),
		"AgentExitedDuringStart": AgentExitedDuringStart("Claude Code", long),
		"AgentTimedOut":          AgentTimedOut("Claude Code", long),
		"AgentRefusedToolServer": AgentRefusedToolServer("Claude Code", "method not supported"),
		"AgentModelRejected":     AgentModelRejected("GitHub Copilot", "gpt-9", []string{"gpt-5", "gpt-4"}, long),
		"AgentSilent":            AgentSilent("Claude Code", "claude auth login", long),
		"AgentStopped.declined":  AgentStopped("Claude Code", StopDeclined, "refusal"),
		"AgentStopped.room":      AgentStopped("Claude Code", StopOutOfRoom, "max_tokens"),
		"AgentStopped.requests":  AgentStopped("Claude Code", StopTooManyRequests, "max_turn_requests"),
		"AgentStopped":           AgentStopped("Claude Code", StopUnknown, "odd"),
		"AgentCrashed":           AgentCrashed("Claude Code", long),
		"AgentUnavailable":       AgentUnavailable("unknown or unavailable agent x"),
		"AgentFailed":            AgentFailed("Claude Code", long),

		"RequestTooLarge":      RequestTooLarge(1 << 20),
		"DataDirInUse":         DataDirInUse("/home/me/.octo", "resource temporarily unavailable"),
		"Unexpected":           Unexpected(errors.New(long)),
		"NoProvider":           NoProvider(),
		"ProviderNotConnected": ProviderNotConnected("Anthropic API", "", "no key"),
		"ProviderNotSupported": ProviderNotSupported("Pi", "its CLI has no ACP mode"),
		"ProviderNotWorking":   ProviderNotWorking("Claude Code", long),
		"ModelCallFailed":      ModelCallFailed("HTTP 500"),
		"ModelUnreachable":     ModelUnreachable("unexpected EOF"),
		"RouterUnreachable":    RouterUnreachable("dial tcp 127.0.0.1:8090: connect: connection refused"),
		"ApiKeyRejected":       ApiKeyRejected("HTTP 401"),
		"TooManySteps":         TooManySteps("exceeded max turns"),
		"Generic":              Generic("a_code_nobody_listed", "boom: a: b: c"),
		"NameRequired":         NameRequired(),
		"FolderInvalid":        FolderInvalid("/nope", "not a directory"),
		"NoteTitleTaken":       NoteTitleTaken("Plan", "n1"),
		"BudgetReached":        BudgetReached(4.2, 5),
		"TurnInProgress":       TurnInProgress(),
		"TurnInterrupted":      TurnInterrupted(),
		"SideInProgress":       SideInProgress(),
		"SideNoAnswer":         SideNoAnswer("no key"),
		"QueueFull":            QueueFull(50),
		"ImagesUnsupported":    ImagesUnsupported("GitHub Copilot"),
		"SteerUnsupported":     SteerUnsupported(),
		"NothingToCompact":     NothingToCompact(),
		"CompactUnsupported":   CompactUnsupported("window memory"),
		"BuiltinLoopOff":       BuiltinLoopOff("set ANTHROPIC_API_KEY"),
		"NewerSchema":          NewerSchema("schema 9 > 7"),
		"PlanNotPending":       PlanNotPending(),
		"FileChanged":          FileChanged(),
		"CompletionFailed":     CompletionFailed(long),
		"ModelsLookupFailed":   ModelsLookupFailed("Claude Code", long),
		"DiscoveryOff":         DiscoveryOff(),
		"CommandFailed":        CommandFailed(long),
		"MemoryFailed":         MemoryFailed(long),
		"NoteFailed":           NoteFailed(long),
		"GitHubCLIMissing":     GitHubCLIMissing("brew install gh"),
		"GitHubCLINotLoggedIn": GitHubCLINotLoggedIn("gh auth login"),
		"GitHubNoRemote":       GitHubNoRemote("git remote add origin URL"),
		"GitMissing":           GitMissing("git: not found"),
		"RepoMismatch":         RepoMismatch("github.com/a/b is not one of x"),
		"InvalidRepo":          InvalidRepo("none of them"),
		"AmbiguousPR":          AmbiguousPR("in a/b and c/d"),
		"DirtyWorkingCopy":     DirtyWorkingCopy(3),
		"CheckoutConflict":     CheckoutConflict("would be overwritten"),
		"CodeHostFailed":       CodeHostFailed("HTTP 502"),
		"GitFailed":            GitFailed("fatal: bad object"),
		"FetchFailed":          FetchFailed("fatal: unable to access"),
		"WorktreeFailed":       WorktreeFailed("fatal: already exists"),

		"SessionRefused":      SessionRefused("not_continuable", "The agent kept no conversation to continue.", "no messages"),
		"InvalidModelSetting": InvalidModelSetting(),
		"NotFoundWhat":        NotFoundWhat("project"),
		"NameTooLong":         NameTooLong(120),
		"BudgetInvalid":       BudgetInvalid(),
		"ModeUnknown":         ModeUnknown(),
		"TitleTaken":          TitleTaken(),
		"CommandNameTaken":    CommandNameTaken(),
		"BranchMissing":       BranchMissing(),
	}
}

var forbidden = []*regexp.Regexp{
	regexp.MustCompile(`ACP`), regexp.MustCompile(`MCP`), regexp.MustCompile(`exit status`), regexp.MustCompile(`stderr`),
	regexp.MustCompile(`JSON-RPC`), regexp.MustCompile(`session/`), regexp.MustCompile(`initialize`), regexp.MustCompile(`spawn_agent`),
	regexp.MustCompile(`(: .*){3}`),          // a Go error chain
	regexp.MustCompile(`\b[a-z]+_[a-z_]+\b`), // a tool or code id with an underscore
}

func TestCatalogueWording(t *testing.T) {
	all := samples()
	for _, code := range GenericCodes() {
		all["Generic."+code] = Generic(code, "technical: text")
	}
	for name, e := range all {
		for field, s := range map[string]string{"message": e.Message, "hint": e.Hint} {
			if s == "" {
				if field == "message" {
					t.Errorf("%s: empty message", name)
				}
				continue
			}
			for _, re := range forbidden {
				if re.MatchString(s) {
					t.Errorf("%s %s %q matches forbidden %q", name, field, s, re)
				}
			}
			r := []rune(s)
			if !unicode.IsUpper(r[0]) {
				t.Errorf("%s %s %q does not start with a capital", name, field, s)
			}
			if !strings.HasSuffix(s, ".") {
				t.Errorf("%s %s %q does not end with a period", name, field, s)
			}
			if len(r) > 140 {
				t.Errorf("%s %s is %d characters (max 140)", name, field, len(r))
			}
		}
		if e.Code == "" {
			t.Errorf("%s: empty code", name)
		}
		if e.Action != ActionNone && !validAction(e.Action) {
			t.Errorf("%s: unknown action %q", name, e.Action)
		}
		if len([]rune(e.Details)) > MaxDetails+1 {
			t.Errorf("%s: details too long", name)
		}
	}
}

func validAction(a Action) bool {
	for _, v := range Actions {
		if v == a {
			return true
		}
	}
	return false
}

// TestEveryConstructorIsListed parses catalogue_*.go and fails for an exported
// function that returns *Error and has no entry in samples().
func TestEveryConstructorIsListed(t *testing.T) {
	files, _ := filepath.Glob("catalogue_*.go")
	files = filterOut(files, "_test.go")
	listed := map[string]bool{}
	for k := range samples() {
		listed[strings.SplitN(k, ".", 2)[0]] = true
	}
	var missing []string
	fset := token.NewFileSet()
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		af, err := parser.ParseFile(fset, f, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range af.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Recv != nil || !fd.Name.IsExported() || fd.Type.Results == nil || len(fd.Type.Results.List) != 1 {
				continue
			}
			if star, ok := fd.Type.Results.List[0].Type.(*ast.StarExpr); ok {
				if id, ok := star.X.(*ast.Ident); ok && id.Name == "Error" && !listed[fd.Name.Name] {
					missing = append(missing, fd.Name.Name)
				}
			}
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("constructors without a sample in samples(): %v", missing)
	}
}

func filterOut(in []string, suffix string) []string {
	var out []string
	for _, s := range in {
		if !strings.HasSuffix(s, suffix) {
			out = append(out, s)
		}
	}
	return out
}

func TestFieldsAndFallback(t *testing.T) {
	e := AgentNotLoggedIn("GitHub Copilot", "copilot login", "run it once")
	f := e.Fields()
	if f["message"] != "GitHub Copilot is not logged in." || f["command"] != "copilot login" || f["action"] != "recheck_provider" || f["details"] != "run it once" || f["hint"] == "" {
		t.Fatalf("fields = %v", f)
	}
	if _, ok := TurnInProgress().Fields()["action"]; ok {
		t.Fatal("an absent action must not be sent")
	}
	u := Of(errors.New("boom: exit status 2"))
	if u.Code != CodeUnexpected || u.Details != "boom: exit status 2" {
		t.Fatalf("fallback = %+v", u)
	}
	wrapped := errors.Join(errors.New("x"), e)
	if As(wrapped) != e {
		t.Fatal("As must find the catalogue error in a chain")
	}
}

func TestValidationWording(t *testing.T) {
	for _, c := range []struct{ code, tech, want string }{
		{"invalid_request", "models.completion must be a model id", "That model setting is not valid."},
		{"invalid_request", "budget_usd must be greater than 0, or null to remove the budget", "A budget has to be a number above zero."},
		{"invalid_request", "mode must be \"a\", \"b\" or \"c\"", "That mode is not one of the choices."},
		{"invalid_request", "name must not be empty", "A name is required."},
		{"invalid_request", "a note titled \"x\" exists (n1); pass its id", "A note with that title exists already."},
		{"not_found", "project not found", "That project no longer exists."},
		{"not_found", "session not found", "That session no longer exists."},
		{"unknown_ref", "unknown_ref", "That branch does not exist in the repository."},
		{"invalid_request", "something else entirely", "That request was not valid."},
	} {
		e := Generic(c.code, c.tech)
		if e.Message != c.want || e.Details != c.tech || e.Hint == "" {
			t.Errorf("%s %q: got %q / %q", c.code, c.tech, e.Message, e.Details)
		}
	}
}
