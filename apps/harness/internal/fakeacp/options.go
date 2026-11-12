package fakeacp

import (
	"os"
	"slices"
	"strings"
)

// Environment switches for the scripted agent. They are read once at start,
// so a test or a plugin manifest configures an agent through its env.
const (
	// EnvAuth makes session/new refuse until authenticate succeeds and
	// advertises auth methods: "ok" offers an interactive method first and then
	// an unattended one, "interactive" only the interactive one.
	EnvAuth = "OCTO_FAKEACP_AUTH"
	// EnvPromptUsage="N" makes every session/prompt response carry
	// usage {inputTokens, outputTokens: N, thoughtTokens: 0}, as an agent that
	// reports per-prompt usage does. Unset: no usage in the response.
	EnvPromptUsage = "OCTO_FAKEACP_PROMPT_USAGE"
	// EnvLoginFile, when set, makes the unattended method succeed only while
	// that file exists (a stand-in for stored credentials).
	EnvLoginFile = "OCTO_FAKEACP_LOGIN_FILE"
	// EnvModels is a comma-separated list of models the agent advertises.
	EnvModels = "OCTO_FAKEACP_MODELS"
	// EnvModelsVia selects where session/new lists them: "models" (the
	// result's models object, the default), "config" (a flat model config
	// option), "config-grouped" (a model config option whose options are
	// groups), "models-array" (models as a bare array of {id, name}), "meta"
	// (models under the result's _meta), or "none" (the models are accepted by
	// session/set_model but not listed).
	EnvModelsVia = "OCTO_FAKEACP_MODELS_VIA"
	// EnvRefuseModel makes set-model refuse ids outside EnvModels.
	EnvRefuseModel = "OCTO_FAKEACP_REFUSE_MODEL"
	// EnvRequestLog is a file every request the agent receives is appended to,
	// one line each: the method, and for session/new "cwd=<dir> mcp=<n>".
	EnvRequestLog = "OCTO_FAKEACP_REQUEST_LOG"
	// EnvAuthMethods is a JSON array of auth methods to advertise verbatim;
	// session/new then refuses until one listed in EnvAuthOK is accepted.
	EnvAuthMethods = "OCTO_FAKEACP_AUTH_METHODS"
	// EnvAuthOK is a comma-separated list of method ids authenticate accepts.
	EnvAuthOK = "OCTO_FAKEACP_AUTH_OK"
	// EnvAuthLog is a file each authenticate attempt's method id is appended to.
	EnvAuthLog = "OCTO_FAKEACP_AUTH_LOG"
	// EnvReportEnv is a comma-separated list of variable names; the final
	// summary says for each whether the agent's environment has it set.
	EnvReportEnv = "OCTO_FAKEACP_REPORT_ENV"
	// EnvLoadSession=1 advertises agentCapabilities.loadSession and serves
	// session/load (replaying a short history as session/update first).
	EnvLoadSession = "OCTO_FAKEACP_LOAD_SESSION"
	// EnvLoadFail=1 makes an agent that advertises loadSession (EnvLoadSession=1) refuse session/load
	// ("session not found"), as one that lost the stored session does.
	EnvLoadFail = "OCTO_FAKEACP_LOAD_FAIL"
	// EnvMCPHTTP=1 advertises agentCapabilities.mcpCapabilities.http, so the
	// client passes an HTTP MCP server; without it only stdio is accepted.
	EnvMCPHTTP = "OCTO_FAKEACP_MCP_HTTP"
	// EnvMCPReject=1 makes session/new and session/load fail when they carry
	// any MCP server (an agent that refuses client MCP servers).
	EnvMCPReject = "OCTO_FAKEACP_MCP_REJECT"
	// EnvUniqueSessions=1 gives every session/new a fresh id
	// (fake-<pid>-<n>) instead of the fixed fake-session-1.
	EnvUniqueSessions = "OCTO_FAKEACP_UNIQUE_SESSIONS"
	// EnvModes=1 advertises session modes (default, ask, plan) in session/new
	// and serves session/set_mode; [mode] reports the current one.
	EnvModes = "OCTO_FAKEACP_MODES"
	// EnvCommands is a ';'-separated list of slash commands the agent
	// advertises (available_commands_update) right after session/new and
	// session/load, each "name|description|input hint" (description and hint
	// optional). A prompt holding "[set-commands:<same list>]" replaces the list
	// mid-session and advertises it again.
	EnvCommands = "OCTO_FAKEACP_COMMANDS"
	// EnvSummary="fail" makes the agent refuse the prompt that asks it for the summary of a
	// session being cleared (any other value: it answers "Agent summary: ...").
	EnvSummary = "OCTO_FAKEACP_SUMMARY"
	// EnvDigest="fail" makes the agent refuse the harness's task-digest prompt (memory M6); "garbage" answers with text that is not JSON.
	EnvDigest = "OCTO_FAKEACP_DIGEST"
	// EnvPromptImage=1 advertises agentCapabilities.promptCapabilities.image;
	// the [blocks] marker reports the content blocks of the prompt.
	EnvPromptImage = "OCTO_FAKEACP_PROMPT_IMAGE"
)

// Auth method ids offered under EnvAuth.
const (
	AuthInteractive = "browser-login"
	AuthUnattended  = "stored-credentials"
)

type options struct {
	auth        string
	loginFile   string
	models      []string
	via         string
	refuseUnk   bool
	startModel  string
	methods     []any
	authOK      []string
	authLog     string
	reportEnv   []string
	promptUsage string

	loadSession bool
	loadFail    bool
	mcpHTTP     bool
	mcpReject   bool
	unique      bool
	modes       bool
	commands    []map[string]any
	promptImage bool
}

func optionsFromEnv(args []string) options {
	o := options{
		auth: os.Getenv(EnvAuth), loginFile: os.Getenv(EnvLoginFile),
		via: os.Getenv(EnvModelsVia), refuseUnk: os.Getenv(EnvRefuseModel) == "1",
		loadSession: os.Getenv(EnvLoadSession) == "1", loadFail: os.Getenv(EnvLoadFail) == "1", mcpHTTP: os.Getenv(EnvMCPHTTP) == "1",
		mcpReject: os.Getenv(EnvMCPReject) == "1", promptUsage: os.Getenv(EnvPromptUsage), unique: os.Getenv(EnvUniqueSessions) == "1",
		modes: os.Getenv(EnvModes) == "1", commands: parseCommandList(os.Getenv(EnvCommands)), promptImage: os.Getenv(EnvPromptImage) == "1",
	}
	for _, m := range strings.Split(os.Getenv(EnvModels), ",") {
		if m = strings.TrimSpace(m); m != "" {
			o.models = append(o.models, m)
		}
	}
	o.loadAuthMethods()
	for i, a := range args {
		if (a == "--model" || a == "-m") && i+1 < len(args) {
			o.startModel = args[i+1]
		}
	}
	return o
}

func (o options) any() bool { return o.auth != "" || len(o.models) > 0 || o.startModel != "" }

func (o options) authMethods() []any {
	if o.auth == authCustom {
		return o.methods
	}
	interactive := map[string]any{"id": AuthInteractive, "name": "Browser login", "type": "terminal"}
	if o.auth == "interactive" {
		return []any{interactive}
	}
	if o.auth == "" {
		return []any{}
	}
	return []any{interactive, map[string]any{"id": AuthUnattended, "name": "Stored login"}}
}

func (o options) knows(model string) bool { return slices.Contains(o.models, model) }

func (o options) initialModel() string {
	switch {
	case o.startModel != "":
		return o.startModel
	case len(o.models) > 0:
		return o.models[0]
	}
	return ""
}

// parseCommandList reads "name|description|hint;..." into availableCommands entries
// (the schema's shape: input is {hint} and absent without a hint).
func parseCommandList(s string) []map[string]any {
	var out []map[string]any
	for _, item := range strings.Split(s, ";") {
		f := strings.Split(strings.TrimSpace(item), "|")
		if f[0] == "" {
			continue
		}
		c := map[string]any{"name": f[0], "description": ""}
		if len(f) > 1 {
			c["description"] = f[1]
		}
		if len(f) > 2 && f[2] != "" {
			c["input"] = map[string]string{"hint": f[2]}
		}
		out = append(out, c)
	}
	return out
}
