package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

const macOSBrowserUpdateRemedy = "请先保存工作并结束运行中的终端，在设置的“版本与组件”中更新环境组件，再重新检测；仅重启不会安装缺失文件。外网保持关闭。"

func (s *Server) requireMacOSBrowserComponents(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	const base = guestos.MacOSBrowserTools + "/controller/"
	const probe = "if test -f " + base + "macos-browser-window.mjs && test -f " + base + "browser-check.html; then exit 0; else exit 78; fi"
	err := s.macOSSSHCommand(ctx, "-T", s.sshTarget(), "--", probe).Run()
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 78 {
		return fmt.Errorf("无法核验 macOS 客机浏览器组件，请确认客机已登录并恢复连接后重试: %w", err)
	}
	failure := fmt.Errorf("%w %s", errGuestUpdateRequired, macOSBrowserUpdateRemedy)
	s.mu.Lock()
	s.guestUpdateRequired = true
	s.guestUpdateError = failure.Error()
	s.mu.Unlock()
	return failure
}

type macBrowserRequest struct {
	Timezone  string `json:"timezone,omitempty"`
	Network   bool   `json:"network,omitempty"`
	Action    string `json:"action"`
	URL       string `json:"url,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Folder    string `json:"folder,omitempty"`
	X         int    `json:"x"`
	Y         int    `json:"y"`
	DX        int    `json:"dx"`
	DY        int    `json:"dy"`
	Double    bool   `json:"double,omitempty"`
	Key       string `json:"key,omitempty"`
	Text      string `json:"text,omitempty"`
	Meta      bool   `json:"meta,omitempty"`
	Ctrl      bool   `json:"ctrl,omitempty"`
	Shift     bool   `json:"shift,omitempty"`
	Alt       bool   `json:"alt,omitempty"`
}

// Keep older installed clients on the same guest Chrome session and project grants.
func (s *Server) macBrowserExchange(ctx context.Context, request macBrowserRequest) ([]byte, error) {
	client := s.nativeBrowserClient()
	if request.Action == "frame" {
		data, err := client.request(ctx, "GET", "/frame", nil)
		if err != nil {
			return nil, err
		}
		var frame struct {
			JPEG          string
			URL           string
			Title         string
			Width, Height int
		}
		if err = json.Unmarshal(data, &frame); err != nil || frame.JPEG == "" {
			return nil, errors.New("请在单个客机浏览器标签中查看画面")
		}
		return json.Marshal(map[string]any{"image": frame.JPEG, "url": frame.URL, "title": frame.Title, "width": frame.Width, "height": frame.Height})
	}
	action := request.Action
	if action == "text" {
		action = "insert-text"
	}
	if action == "editor" {
		_, err := client.request(ctx, "POST", "/editor", map[string]string{"workspace": filepath.Base(request.Folder)})
		if err != nil {
			return nil, err
		}
		return []byte(`{"ok":true}`), nil
	}
	return client.request(ctx, "POST", "/"+action, request)
}

func (s *Server) registerMacOSBrowserRoutes(mux routeRegistrar) {
	mux.HandleFunc("POST /api/macos-browser/action", func(w http.ResponseWriter, r *http.Request) {
		if s.macosGuest == nil {
			http.NotFound(w, r)
			return
		}
		s.mu.Lock()
		ready := s.ready && !s.closing
		s.mu.Unlock()
		if !ready {
			http.Error(w, "请先启动 macOS 客机", http.StatusConflict)
			return
		}
		var request macBrowserRequest
		if !readJSON(w, r, &request) {
			return
		}
		// A guest filesystem path is derived only from an already granted host project.
		request.Folder = ""
		switch request.Action {
		case "editor":
			if request.Workspace == "" {
				http.Error(w, "请先打开项目", 400)
				return
			}
			if !s.op.TryLock() {
				http.Error(w, "正在处理其他项目操作", 409)
				return
			}
			project, err := s.connectProject(request.Workspace, false)
			s.op.Unlock()
			if err != nil || isClientMountPath(project) {
				http.Error(w, "请先打开并授权本机项目", 409)
				return
			}
			request.Folder = macOSProjectPath(s.macosGuest.User, project)
		case "navigate":
			u, err := url.Parse(request.URL)
			if err != nil || u == nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || len(request.URL) > 4096 {
				http.Error(w, "请输入 HTTP 或 HTTPS 地址", 400)
				return
			}
		case "text", "key", "click", "wheel", "back", "forward", "frame", "reload":
		default:
			http.Error(w, "未知的客机浏览器操作", 400)
			return
		}
		request.Workspace = "" // never expose a host pathname to the guest browser
		if len(request.Text) > 8192 || len(request.Key) > 32 || request.X < 0 || request.Y < 0 || request.X > 1140 || request.Y > 700 || request.DX > 2000 || request.DX < -2000 || request.DY > 2000 || request.DY < -2000 {
			http.Error(w, "输入超出范围", 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 28*time.Second)
		defer cancel()
		data, err := s.macBrowserExchange(ctx, request)
		if err != nil {
			http.Error(w, "无法连接客机里的浏览器，请检查客机运行状态", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	})
}
