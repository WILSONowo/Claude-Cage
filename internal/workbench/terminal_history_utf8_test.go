package workbench

import (
	"io"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTerminalHistoryTruncationPreservesUTF8(t *testing.T) {
	for _, character := range []string{"é", "中", "🙂"} {
		t.Run(character, func(t *testing.T) {
			session, file := newControlledSession()
			t.Cleanup(func() { close(file.waitRelease); session.close() })
			// Cross the history limit at a continuation byte for two-, three-
			// and four-byte characters, including ordinary PTY read boundaries.
			const limit = 512 << 10
			output := strings.Repeat(character, limit/len(character)+2) + "\n"
			if _, err := io.WriteString(file.writer, output); err != nil {
				t.Fatal(err)
			}
			if err := file.writer.Close(); err != nil {
				t.Fatal(err)
			}
			awaitTerminalSignal(t, file.waitStarted)
			subscription := session.subscribe()
			defer subscription.Close()
			history := subscription.History
			if !utf8.Valid(history) {
				t.Fatalf("reconnected history begins with a partial character: %x", history[:min(len(history), 4)])
			}
			if len(history) > limit || len(history) < limit-utf8.UTFMax+1 || !strings.HasSuffix(output, string(history)) {
				t.Fatalf("history did not preserve the bounded output suffix: %d bytes", len(history))
			}
		})
	}
}
