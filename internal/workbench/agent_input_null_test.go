package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestAgentRejectsNullOperationFields(t *testing.T) {
	for _, operation := range AgentOperations() {
		properties, _ := operation.InputSchema["properties"].(map[string]any)
		for field := range properties {
			t.Run(operation.Name+"/"+field, func(t *testing.T) {
				input, err := json.Marshal(map[string]any{field: nil})
				if err != nil {
					t.Fatal(err)
				}
				err = agentValidateInput(input, operation.InputSchema)
				var failure *AgentError
				if !errors.As(err, &failure) || failure.Code != "invalid_input" {
					t.Fatalf("non-nullable field accepted null: %s: %v", input, err)
				}
			})
		}
		if err := agentValidateInput(json.RawMessage(`{}`), operation.InputSchema); err != nil {
			t.Fatalf("omitted optional fields rejected for %s: %v", operation.Name, err)
		}
	}
}

func TestAgentRejectsNullAllocationBeforeConnecting(t *testing.T) {
	// A present null allocation must never be forwarded as the empty request
	// that the resource handler interprets as apply-and-restart.
	_, err := AgentCall(context.Background(), filepath.Join(t.TempDir(), "config.json"), "resources.set", json.RawMessage(`{"allocation": null}`))
	var failure *AgentError
	if !errors.As(err, &failure) || failure.Code != "invalid_input" {
		t.Fatalf("null allocation reached the controller connection: %v", err)
	}
}
