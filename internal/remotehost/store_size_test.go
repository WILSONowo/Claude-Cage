package remotehost

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHostStoreRejectsOversizedEncodedListBeforeReplacingIt(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	var saved []HostProfile
	var before []byte
	for i := 0; i < 100; i++ {
		before, _ = os.ReadFile(filepath.Join(dir, "remote-hosts.json"))
		profile := HostProfile{Name: fmt.Sprintf("host-%d", i), Host: "example.invalid", User: "user", Auth: AuthConfig{Kind: "agent"},
			// These are allowed POSIX paths. JSON escaping makes the encoded
			// list much larger than a sum of the original field lengths.
			Executable: "/" + strings.Repeat("<", 4095), ConfigPath: "/" + strings.Repeat("&", 4095)}
		added, err := store.Upsert(profile)
		if err == nil {
			saved = append(saved, added)
			continue
		}
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != "profile_limit" {
			t.Fatalf("the previously saved list became unreadable: %v", err)
		}
		break
	}
	if len(saved) == 0 || len(saved) == 100 {
		t.Fatalf("expected a cumulative encoded-size limit below the host-count limit, saved %d", len(saved))
	}
	after, err := os.ReadFile(filepath.Join(dir, "remote-hosts.json"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("rejected update replaced the previous host file", err)
	}
	listed, err := store.List()
	if err != nil || len(listed) != len(saved) {
		t.Fatalf("previous host list is unavailable: count=%d error=%v", len(listed), err)
	}
	if got, err := store.Get(saved[0].ID); err != nil || got.Name != saved[0].Name {
		t.Fatalf("previous host cannot be read: %v", err)
	}
	if err := store.Delete(saved[0].ID); err != nil {
		t.Fatalf("previous host cannot be removed: %v", err)
	}
	if got, err := store.List(); err != nil || len(got) != len(saved)-1 {
		t.Fatalf("list cannot be updated after rejected save: count=%d error=%v", len(got), err)
	}
}
