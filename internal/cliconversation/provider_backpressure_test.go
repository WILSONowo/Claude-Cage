package cliconversation

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestApprovalPromptDoesNotBlockStartupOutput(t *testing.T) {
	const fixture = "CAGE_CLI_APPROVAL_BACKPRESSURE_FIXTURE"
	prompt := strings.Repeat("x", maxPromptBytes)
	if os.Getenv(fixture) == "1" {
		input := bufio.NewReader(os.Stdin)
		if _, err := input.ReadBytes('\n'); err != nil {
			os.Exit(2)
		}
		fmt.Println(`{"type":"control_response","response":{"subtype":"success","request_id":"cage-cli-initialize"}}`)
		// An initialization event can be larger than the OS stdout pipe while
		// Claude has not started consuming the complete user message yet.
		fmt.Printf("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":%q,\"fixture\":%q}\n", testSessionID, strings.Repeat("y", 1<<20))
		line, err := input.ReadBytes('\n')
		var user struct {
			Message struct{ Content string } `json:"message"`
		}
		if err != nil || json.Unmarshal(line, &user) != nil || user.Message.Content != prompt {
			os.Exit(3)
		}
		fmt.Printf("{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":%q,\"result\":\"ok\"}\n", testSessionID)
		_, _ = io.Copy(io.Discard, input)
		os.Exit(0)
	}
	runner := Runner{
		Approve: func(context.Context, PermissionRequest) bool { return false },
		Command: func(ctx context.Context, _ string, _ []string) (*exec.Cmd, error) {
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestApprovalPromptDoesNotBlockStartupOutput$")
			cmd.Env = append(os.Environ(), fixture+"=1")
			return cmd, nil
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := runner.Run(ctx, Turn{Workspace: t.TempDir(), SessionID: testSessionID, Prompt: prompt}, nil)
	if err != nil || !result.Started || result.Text != "ok" {
		t.Fatalf("large approval prompt stalled startup: result=%#v err=%v", result, err)
	}
}
