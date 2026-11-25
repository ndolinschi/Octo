package cache

import (
	"path/filepath"
	"testing"
)

func TestPutGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c := New(dir)
	key := "http://127.0.0.1:9100/tools"
	data := []byte(`[{"name":"echo"}]`)

	if err := c.Put(key, data); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, ok := c.Get(key)
	if !ok {
		t.Fatal("Get miss")
	}
	if string(got) != string(data) {
		t.Fatalf("got %q", got)
	}

	_, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
}

func TestGetMiss(t *testing.T) {
	c := New(t.TempDir())
	if _, ok := c.Get("http://example/tools"); ok {
		t.Fatal("expected miss")
	}
}
