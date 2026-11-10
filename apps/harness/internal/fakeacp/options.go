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
	// EnvLoginFile, when set, makes the unattended method succeed only while
	// that file exists (a stand-in for stored credentials).
	EnvLoginFile = "OCTO_FAKEACP_LOGIN_FILE"
	// EnvModels is a comma-separated list of models the agent advertises.
	EnvModels = "OCTO_FAKEACP_MODELS"
	// EnvModelsVia selects how they are advertised: "models" (session/set_model,
	// the default) or "config" (a model config option).
	EnvModelsVia = "OCTO_FAKEACP_MODELS_VIA"
	// EnvRefuseModel makes set-model refuse ids outside EnvModels.
	EnvRefuseModel = "OCTO_FAKEACP_REFUSE_MODEL"
)

// Auth method ids offered under EnvAuth.
const (
	AuthInteractive = "browser-login"
	AuthUnattended  = "stored-login"
)

type options struct {
	auth       string
	loginFile  string
	models     []string
	viaConfig  bool
	refuseUnk  bool
	startModel string
}

func optionsFromEnv(args []string) options {
	o := options{
		auth: os.Getenv(EnvAuth), loginFile: os.Getenv(EnvLoginFile),
		viaConfig: os.Getenv(EnvModelsVia) == "config", refuseUnk: os.Getenv(EnvRefuseModel) == "1",
	}
	for _, m := range strings.Split(os.Getenv(EnvModels), ",") {
		if m = strings.TrimSpace(m); m != "" {
			o.models = append(o.models, m)
		}
	}
	for i, a := range args {
		if (a == "--model" || a == "-m") && i+1 < len(args) {
			o.startModel = args[i+1]
		}
	}
	return o
}

func (o options) any() bool { return o.auth != "" || len(o.models) > 0 || o.startModel != "" }

func (o options) authMethods() []any {
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
