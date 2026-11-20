package guestos

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Run both real shell entry points, including concurrent CLI downloads and the
// GitHub asset fallback. A host helper path with spaces must remain one command.
func TestMacMediaUsesHostDownloaderForEveryPackage(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	dir := t.TempDir()
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("fixture")))
	for _, name := range []string{"prepare-macos-media.sh", "prepare-macos-cli-kit.sh"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "scripts", "guest-os", name))
		if err != nil {
			t.Fatal(err)
		}
		data = regexp.MustCompile(`[a-f0-9]{64}`).ReplaceAll(data, []byte(digest))
		if err := os.WriteFile(filepath.Join(dir, name), data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"macos-cli.py", "install-macos-cli.sh", "claude-account.py", "cli_channel.py", "cli_channel.resume.md", "claude_account_resume.md", "client_runtime.py"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(dir, "Cage helper")
	body := `#!/bin/sh
set -eu
test "$1" = host-download
case "$4" in chrome.dmg|macos-cli-latest|macos-cli-manifest.json) test "$#" = 5;; *) test "$6" = "$FIXTURE_MEDIA/.downloads"; test "$7" = "$FIXTURE_DIGEST";; esac
printf '%s %s %s\n' "$2" "$4" "${5:-}" > "$(mktemp "$FIXTURE_DOWNLOADS/request.XXXXXXXX")"
case "$4" in macos-cli-git.tar.gz) test ! -f "$FIXTURE_MEDIA/fail-git" || exit 1;; esac
case "$2" in https://github.com/*) exit 1;; esac
case "$2" in https://api.github.com/*) test "$5" = application/octet-stream;; esac
case "$4" in
  macos-cli-latest) printf 2.1.322 > "$3";;
  macos-cli-manifest.json) printf '{"version":"2.1.322","platforms":{"darwin-arm64":{"binary":"claude","checksum":"%s"}}}' "$FIXTURE_DIGEST" > "$3";;
  *) printf fixture > "$3";;
esac
printf 'CAGE_HOST_BYTES %s 7 7\n' "$4"
`
	if err := os.WriteFile(helper, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	environment := filepath.Join(dir, "environment.sh")
	if err := os.WriteFile(environment, []byte(`codesign() { :; }
plutil() {
  case "$2" in version) printf 2.1.322;; platforms.darwin-arm64.binary) printf claude;; platforms.darwin-arm64.checksum) printf '%s' "$FIXTURE_DIGEST";; *) return 1;; esac
}
`), 0600); err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(dir, "media")
	if err := os.Mkdir(media, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(media, "fail-git")
	if err := os.WriteFile(marker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	// The shell may see a POSIX mount path for the same test directory
	// (for example, bash via WSL). Resolve shell arguments within that shell.
	const runner = `set -eu
export BASH_ENV="$PWD/environment.sh" CAGE_HOST_DOWNLOADER="$PWD/Cage helper" CAGE_REFRESH_TOOLS=1
export FIXTURE_MEDIA="$PWD/media" FIXTURE_DIGEST="$1" FIXTURE_DOWNLOADS="$PWD/requests"
exec bash ./prepare-macos-media.sh "$FIXTURE_MEDIA"
`
	if err := os.WriteFile(filepath.Join(dir, "run-fixture.sh"), []byte(runner), 0700); err != nil {
		t.Fatal(err)
	}
	run := func() ([]byte, error) {
		cmd := exec.CommandContext(t.Context(), "bash", "./run-fixture.sh", digest)
		cmd.Dir = dir
		return cmd.CombinedOutput()
	}
	requestDir := filepath.Join(dir, "requests")
	if err := os.Mkdir(requestDir, 0700); err != nil {
		t.Fatal(err)
	}
	output, err := run()
	if err == nil {
		t.Fatal("incomplete CLI kit was published")
	}
	if err = os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	retry, err := run()
	if err != nil {
		t.Fatalf("%v\n%s", err, retry)
	}
	output = append(output, retry...)
	var requests []byte
	entries, err := os.ReadDir(requestDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range entries {
		data, err := os.ReadFile(filepath.Join(requestDir, item.Name()))
		if err != nil {
			t.Fatal(err)
		}
		requests = append(requests, data...)
	}
	if strings.Count(string(requests), " macos-cli-claude ") != 1 {
		t.Fatalf("expected exactly one CLI download across both runs; requests:\n%s", requests)
	}
	for _, name := range []string{"editor.tgz", "node.tgz", "chrome.dmg", "macos-cli-claude", "macos-cli-uv.tar.gz", "macos-cli-python.tar.gz", "macos-cli-git.tar.gz"} {
		if !strings.Contains(string(requests), " "+name+" ") || !strings.Contains(string(output), "CAGE_HOST_BYTES "+name+" 7 7") {
			t.Fatalf("component bypassed host download helper: %s\n%s", name, requests)
		}
	}
	for _, name := range []string{"claude", "uv.tar.gz", "python.tar.gz", "git.tar.gz"} {
		data, err := os.ReadFile(filepath.Join(media, "cli", name))
		if err != nil || string(data) != "fixture" {
			t.Fatalf("CLI kit not published: %s %v", name, err)
		}
	}
}
