package workbench

import (
	"net/http"
	"path/filepath"

	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/hostimage"
)

func (s *Server) hostClone(w http.ResponseWriter, r *http.Request) {
	if !s.hasTrustedView(r) || !s.localVMStorage() {
		http.Error(w, "请在本机 Cage 窗口选择系统创建方式", http.StatusForbidden)
		return
	}
	view, err := s.guestInstallView()
	if err != nil {
		requestError(w, err)
		return
	}
	if !view.Available || view.Pending == nil || view.Pending.SourceKind != "" || view.Pending.Source.Host.System == "" {
		http.Error(w, "新环境使用 Debian 13。仅已有的本机系统匹配任务可继续。", http.StatusConflict)
		return
	}
	plan := view.Pending.Source
	minimumGiB := 32
	if hostimage.IsLinux(plan.Host.System) {
		minimumGiB = 16
	}
	started := !view.Reselect
	if started {
		minimumGiB = 0
	}
	downloadBytes := plan.RemainingBytes(filepath.Join(s.profile, "state", "guest-media", plan.Host.System))
	minimumGiB += int((downloadBytes + (1 << 30) - 1) / (1 << 30))
	freeGiB, measured := host.FreeGiB(filepath.Join(s.profile, "state"))
	jsonReply(w, map[string]any{
		"plan": plan, "key": plan.Key(), "download_bytes": downloadBytes,
		"minimum_free_gib": minimumGiB, "free_gib": freeGiB,
		"installation_started": started,
		"enough_space":         !measured || freeGiB >= minimumGiB,
	})
}
