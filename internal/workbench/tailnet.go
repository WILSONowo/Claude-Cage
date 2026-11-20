package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const tailnetConfigFile = "tailscale.json"

type tailnetConfig struct {
	ControlURL string `json:"control_url,omitempty"`
}

func normalizeTailnetControlURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > 256 {
		return "", errors.New("控制服务器地址过长")
	}
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("控制服务器地址须为有效的 HTTPS 地址，例如 https://headscale.example.com")
	}
	if u.Path != "" && u.Path != "/" {
		return "", errors.New("控制服务器地址只需填写协议、域名和端口，不要包含路径")
	}
	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	if host == "" || strings.ContainsAny(host, " \t\r\n") {
		return "", errors.New("控制服务器地址缺少有效主机名")
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("控制服务器端口须在 1–65535 之间")
		}
		if n == 443 {
			port = ""
		} else {
			port = strconv.Itoa(n)
		}
	}
	if host == "controlplane.tailscale.com" && port == "" {
		return "", nil
	}
	authority := host
	if port != "" {
		authority = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		authority = "[" + host + "]"
	}
	return "https://" + authority, nil
}

func loadTailnetConfig(profile string) (tailnetConfig, error) {
	path := filepath.Join(profile, tailnetConfigFile)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return tailnetConfig{}, nil
	}
	if err != nil {
		return tailnetConfig{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 16<<10 {
		return tailnetConfig{}, errors.New("Tailscale 控制服务器配置无效")
	}
	f, err := os.Open(path)
	if err != nil {
		return tailnetConfig{}, err
	}
	defer f.Close()
	var cfg tailnetConfig
	d := json.NewDecoder(io.LimitReader(f, 16<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(&cfg); err != nil {
		return tailnetConfig{}, errors.New("Tailscale 控制服务器配置无效")
	}
	normalized, err := normalizeTailnetControlURL(cfg.ControlURL)
	if err != nil {
		return tailnetConfig{}, err
	}
	cfg.ControlURL = normalized
	return cfg, nil
}

func saveTailnetConfig(profile string, cfg tailnetConfig) error {
	normalized, err := normalizeTailnetControlURL(cfg.ControlURL)
	if err != nil {
		return err
	}
	path := filepath.Join(profile, tailnetConfigFile)
	if normalized == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writePrivate(path, tailnetConfig{ControlURL: normalized})
}

func validTailnetAuthURL(raw string) bool {
	return validTailnetAuthURLFor(raw, "")
}

func validTailnetAuthURLFor(raw, controlURL string) bool {
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || u.User != nil || u.Fragment != "" {
		return false
	}
	if controlURL == "" {
		return u.Host == "login.tailscale.com" && len(u.Path) > 3 && (u.Path[:3] == "/a/" || u.Path[:3] == "/c/")
	}
	if u.Path == "" || u.Path == "/" {
		return false
	}
	origin, err := normalizeTailnetControlURL("https://" + u.Host)
	return err == nil && origin == controlURL
}

func (s *Server) tailnet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	action := r.PathValue("action")
	if r.Method == http.MethodGet {
		action = "status"
	}
	if action == "install" {
		var input struct{}
		if !readJSON(w, r, &input) {
			return
		}
		s.launch(w, "tailscale-install", s.installTailnet)
		return
	}
	switch action {
	case "status", "connect", "login", "disconnect", "logout", "control-server", "add-key", "remove-key", "open-service":
	default:
		http.NotFound(w, r)
		return
	}
	var input struct {
		Key        string `json:"key"`
		Host       string `json:"host,omitempty"`
		Port       int    `json:"port,omitempty"`
		ControlURL string `json:"control_url,omitempty"`
	}
	if r.Method != http.MethodGet && !readJSON(w, r, &input) {
		return
	}
	if len(input.Key) > 8192 {
		http.Error(w, "SSH 公钥过长", 400)
		return
	}
	if action == "open-service" && (len(input.Host) == 0 || len(input.Host) > 253 || input.Port < 1 || input.Port > 65535) {
		http.Error(w, "请选择私网设备并填写 1–65535 之间的端口", 400)
		return
	}
	hostCfg, err := loadTailnetConfig(s.profile)
	if err != nil && action != "control-server" {
		http.Error(w, "Tailscale 控制服务器配置已损坏，已拒绝连接；请重新保存控制服务器设置", 500)
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Get("config") == "1" {
		jsonReply(w, hostCfg)
		return
	}
	if action == "control-server" {
		normalized, err := normalizeTailnetControlURL(input.ControlURL)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := saveTailnetConfig(s.profile, tailnetConfig{ControlURL: normalized}); err != nil {
			http.Error(w, "保存控制服务器地址失败", 500)
			return
		}
		hostCfg.ControlURL = normalized
	}
	s.mu.Lock()
	ready, token := s.ready, s.credentials.Token
	busy := s.jobs.snapshot().Running
	s.mu.Unlock()
	if !ready || busy {
		if action == "control-server" {
			jsonReply(w, map[string]any{"installed": false, "enabled": false, "backend": "Stopped", "control_url": hostCfg.ControlURL, "ips": []string{}, "peers": []string{}, "keys": []string{}})
			return
		}
		http.Error(w, "请先启动 Cage 环境，并等待当前操作完成", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var override *string
	if action == "connect" || action == "login" || action == "control-server" {
		override = &hostCfg.ControlURL
	}
	body, _ := json.Marshal(struct {
		Action     string  `json:"action"`
		ControlURL *string `json:"control_url,omitempty"`
		Key        string  `json:"key,omitempty"`
		Host       string  `json:"host,omitempty"`
		Port       int     `json:"port,omitempty"`
	}{action, override, input.Key, input.Host, input.Port})
	data, err := s.guestAPI(ctx, token, http.MethodPost, "/tailnet", body)
	if err != nil {
		http.Error(w, "Tailscale 操作未完成。请更新环境组件后重试；原设备身份和 SSH 公钥会保留。", 502)
		return
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		http.Error(w, "Tailscale 组件返回了无效状态", 502)
		return
	}
	if b := result["tailnet_error"]; len(b) > 0 {
		var reason string
		_ = json.Unmarshal(b, &reason)
		http.Error(w, reason, 502)
		return
	}
	var authURL string
	_ = json.Unmarshal(result["auth_url"], &authURL)
	if authURL != "" && !validTailnetAuthURLFor(authURL, hostCfg.ControlURL) {
		http.Error(w, "Tailscale 登录地址无效，请重新发起登录", 502)
		return
	}
	// Always publish the host's authoritative control_url.
	if hostCfg.ControlURL != "" {
		rawURL, _ := json.Marshal(hostCfg.ControlURL)
		result["control_url"] = rawURL
	} else {
		delete(result, "control_url")
	}
	out, err := json.Marshal(result)
	if err != nil {
		http.Error(w, "Tailscale 组件返回了无效状态", 502)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

var errTailnetNativeInstall = errors.New("请在设置中更新环境组件，Tailscale 随客机组件一同安装")
