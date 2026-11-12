package workbench

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
)

const retainedJobs = 12

func (m *jobManager) loadHistory(profile string) {
	m.historyFile = filepath.Join(profile, "job-history.json")
	f, err := os.Open(m.historyFile)
	if err != nil {
		return
	}
	defer f.Close()
	var jobs []Job
	if err := json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(&jobs); err == nil {
		m.history = jobs[:min(len(jobs), retainedJobs)]
	}
}

func (m *jobManager) rememberLocked(job Job) {
	// The command stream is already redacted. Store only fields used in the history viewer.
	job.Message = diagnostics.Redact(job.Message)
	job.Error = diagnostics.Redact(job.Error)
	job.Workspace, job.Recovery, job.SetupProgress = "", "", nil
	m.history = append([]Job{job}, m.history[:min(len(m.history), retainedJobs-1)]...)
	if m.historyFile != "" {
		if err := writePrivate(m.historyFile, m.history); err != nil {
			diagnostics.Log("warn", "task", "无法保存操作历史")
		}
	}
}

func (m *jobManager) recent() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Job{}, m.history...)
}

func (m *jobManager) hasHistory() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.history) > 0
}
