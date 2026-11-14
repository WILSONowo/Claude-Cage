package cage

import (
	"os"
	"testing"
)

func TestProcessSnapshotAgreesWithRecordedStart(t *testing.T) {
	current := processStartToken(os.Getpid())
	if current == "" || snapshotStartToken(os.Getpid()) != current {
		t.Fatal("system snapshot and process handle disagree on creation time")
	}
	if token := snapshotStartToken(-1); token != "" {
		t.Fatal("nonexistent process has a creation time")
	}
}
