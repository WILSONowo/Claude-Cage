package vm

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigReplacementWithOpenReader(t *testing.T) {
	dir := t.TempDir()
	tmp, path := filepath.Join(dir, "pending"), filepath.Join(dir, "current")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmp, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
	defer cancel()
	if err := replaceLimaConfig(ctx, tmp, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "old" {
		t.Fatalf("lost original: %q %v", b, err)
	}
	done := make(chan error, 1)
	go func() { done <- replaceLimaConfig(t.Context(), tmp, path) }()
	time.Sleep(50 * time.Millisecond)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "new" {
		t.Fatalf("replacement: %q %v", b, err)
	}
}
