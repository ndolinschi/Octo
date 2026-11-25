package remoteaccess

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWebClientStatus(t *testing.T) {
	dir := t.TempDir()
	if ok, why := WebClientStatus("", ""); ok || !strings.Contains(why, EnvWebDir+" is not set") {
		t.Fatalf("unset: %v %q", ok, why)
	}
	if ok, why := WebClientStatus(dir, ""); ok || !strings.Contains(why, "no index.html") {
		t.Fatalf("empty dir: %v %q", ok, why)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := WebClientStatus(dir, ""); !ok {
		t.Fatal("a dir with index.html is available")
	}
	if ok, _ := WebClientStatus("", "http://127.0.0.1:5173"); !ok {
		t.Fatal("a dev proxy is available")
	}
}
