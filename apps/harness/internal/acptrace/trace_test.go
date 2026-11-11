package acptrace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func start(t *testing.T, env []string, scrub func(string) string) *Trace {
	t.Helper()
	Configure(t.TempDir(), true)
	t.Cleanup(func() { Configure(t.TempDir(), false) })
	tr := Begin("claude-code", env, scrub)
	if tr == nil {
		t.Fatal("tracing is on but Begin returned nil")
	}
	t.Cleanup(tr.Close)
	return tr
}

func read(t *testing.T, tr *Trace) string {
	t.Helper()
	b, err := os.ReadFile(tr.Path())
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestOffByDefaultWritesNothing(t *testing.T) {
	Configure(t.TempDir(), false)
	if Begin("x", nil, nil) != nil || len(Files()) != 0 {
		t.Fatal("a trace was written while tracing is off")
	}
	var nilTrace *Trace
	nilTrace.Sent([]byte("{}")) // a nil trace is a no-op
	nilTrace.Close()
}

func TestRedactsSecretsEverywhere(t *testing.T) {
	const bearer = "tok-Abc123xyz-bearer"
	const envVal = "plain-env-value-42"
	const proj = "sk-project-secret-1"
	tr := start(t, []string{envVal}, func(s string) string { return strings.ReplaceAll(s, proj, "[secret]") })
	tr.Sent([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/w","mcpServers":[` +
		`{"type":"http","name":"octo-harness","url":"http://127.0.0.1:1/mcp/p","headers":[{"name":"Authorization","value":"Bearer ` + bearer + `"}]},` +
		`{"name":"relay","command":"/bin/h","args":["--token-env","OCTO_MCP_TOKEN"],"env":[{"name":"OCTO_MCP_TOKEN","value":"` + bearer + `"},{"name":"PATH","value":"/usr/bin:/secret/place"}]}]}}`))
	tr.Received([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"text":"my env is ` + envVal + ` and ` + proj + `","api_key":"abc","apiKey":"def","note":"Authorization: Bearer ` + bearer + `"}}}`))
	tr.Received([]byte("not json, and says " + envVal + " and Bearer " + bearer))
	tr.Stderr("stderr leak " + proj)
	got := read(t, tr)
	for _, leaked := range []string{bearer, envVal, proj, `"abc"`, `"def"`, "/secret/place"} {
		if strings.Contains(got, leaked) {
			t.Errorf("the trace contains %q:\n%s", leaked, got)
		}
	}
	for _, kept := range []string{"session/new", "session/update", "client->agent", "agent->client", "agent-stderr", "octo-harness", "http://127.0.0.1:1/mcp/p", Redacted} {
		if !strings.Contains(got, kept) {
			t.Errorf("the trace lost %q:\n%s", kept, got)
		}
	}
	st, err := os.Stat(tr.Path())
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("trace file mode: %v %v", st, err)
	}
}

func TestFileIsCappedAndKeepsTheNewestLines(t *testing.T) {
	tr := start(t, nil, nil)
	tr.max = 4096 // the cap is a field so the test need not write 5 MB
	for i := 0; i < 200; i++ {
		tr.Received([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"n":` + itoa(i) + `,"pad":"` + strings.Repeat("x", 100) + `"}}`))
	}
	got := read(t, tr)
	if int64(len(got)) > tr.max+1024 {
		t.Fatalf("file is %d bytes, cap %d", len(got), tr.max)
	}
	if !strings.Contains(got, `"n":199`) || strings.Contains(got, `"n":0,`) || !strings.Contains(got, "older lines were dropped") {
		t.Fatalf("the cap must drop the oldest lines and say so:\n%.400s", got)
	}
	// Every kept line is still valid JSON lines.
	for _, l := range strings.Split(strings.TrimSpace(got), "\n") {
		if !strings.HasPrefix(l, "{") || !strings.HasSuffix(l, "}") {
			t.Fatalf("broken line after truncation: %q", l)
		}
	}
}

func TestOldestFilesAreDropped(t *testing.T) {
	Configure(t.TempDir(), true)
	t.Cleanup(func() { Configure(t.TempDir(), false) })
	for i := 0; i < MaxFiles+7; i++ {
		Begin("a", nil, nil).Close()
	}
	if n := len(Files()); n > MaxFiles {
		t.Fatalf("%d trace files kept, cap %d", n, MaxFiles)
	}
	for _, f := range Files() {
		if filepath.Dir(f) != Dir() {
			t.Fatalf("file outside the trace dir: %s", f)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}
