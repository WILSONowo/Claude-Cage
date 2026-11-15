// Package appupdate downloads Cage releases through the selected managed egress.
// Signature verification and application replacement belong to the native app.
package appupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/sylvinus/agent-vm/internal/appupdate/catalog"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
	"github.com/sylvinus/agent-vm/internal/usererror"
	"github.com/sylvinus/agent-vm/internal/version"
)

const repository = catalog.Repository
const releasesURL = catalog.ReleasesURL
const maxArchive = catalog.MaxArchive
const maxMetadata = 4 << 20

type asset = catalog.Asset
type release = catalog.Release
type candidate = catalog.Candidate

// State is one line of the native launcher's private update process protocol.
// ArchivePath is returned only to the native launcher, never as a download URL.
type State struct {
	Phase          string `json:"phase"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	ReceivedBytes  int64  `json:"receivedBytes,omitempty"`
	TotalBytes     int64  `json:"totalBytes,omitempty"`
	Message        string `json:"message,omitempty"`
	Retryable      bool   `json:"retryable,omitempty"`
	RetryAt        string `json:"retryAt"`
	ArchivePath    string `json:"archivePath,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
}

type proxyUnavailableError struct{ message string }

func (e *proxyUnavailableError) Error() string { return e.message }

// Run only accepts fixed operations. URLs and destinations come from the
// verified repository response and the current private profile.
func Run(configPath string, args []string, output io.Writer) int {
	enc := json.NewEncoder(output)
	state := State{CurrentVersion: version.Version}
	emit := func() { _ = enc.Encode(state) }
	fail := func(err error) int {
		var unavailable *proxyUnavailableError
		if len(args) == 1 && args[0] == "check" && errors.As(err, &unavailable) {
			state.Phase, state.Message, state.Retryable = "waiting", err.Error(), true
			emit()
			return 0
		}
		_ = diagnostics.New(filepath.Dir(configPath)).Record("warn", "app-update", fmt.Sprintf("%v; cause=%v", err, errors.Unwrap(err)))
		state.fail(err)
		emit()
		return 1
	}
	if len(args) != 1 || (args[0] != "check" && args[0] != "download") {
		return fail(errors.New("更新操作无效"))
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client, err := managedClient(ctx, configPath)
	if err != nil {
		return fail(err)
	}
	defer client.CloseIdleConnections()
	state.Phase, state.Message = "checking", "正在检查更新"
	emit()
	c, err := findRelease(ctx, client, version.Version)
	if err != nil {
		return fail(err)
	}
	if c == nil {
		state.Phase, state.Message = "current", "已是当前更新通道的最新版本"
		emit()
		return 0
	}
	state.LatestVersion = c.Version
	if args[0] == "check" {
		state.Phase, state.Message = "available", "发现新版本，可下载更新"
		emit()
		return 0
	}
	digest, err := releaseDigest(ctx, client, *c)
	if err != nil {
		return fail(err)
	}
	directory := filepath.Join(filepath.Dir(configPath), "updates")
	if err = host.EnsurePrivateDir(directory); err != nil {
		return fail(errors.New("无法创建私有更新目录"))
	}
	if st, e := os.Lstat(directory); e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fail(errors.New("更新目录必须是私有普通目录"))
	}

	job, err := os.MkdirTemp(directory, "download-")
	if err != nil {
		return fail(errors.New("无法创建更新下载任务"))
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(job)
		}
	}()
	if err = host.EnsurePrivateDir(job); err != nil {
		return fail(err)
	}
	localName := "Cage.dmg"
	if runtime.GOOS == "windows" {
		localName = "Cage-setup.exe"
	}
	archive := filepath.Join(job, localName)
	state.Phase, state.Message, state.TotalBytes = "downloading", "正在下载更新", c.Archive.Size
	emit()
	err = download(ctx, client, c.Archive, digest, archive, func(n int64) {
		state.ReceivedBytes = n
		emit()
	})
	if err != nil {
		return fail(err)
	}
	keep = true
	state.Phase, state.Message, state.ArchivePath, state.SHA256 = "downloaded", "下载摘要已校验，正在验证应用", archive, digest
	emit()
	return 0
}

func managedClient(ctx context.Context, configPath string) (*http.Client, error) {
	cfg, err := cage.Load(configPath)
	if err != nil {
		return nil, errors.New("请先配置并启动 Cage 的所选代理，再检查更新")
	}
	profile := filepath.Dir(configPath)
	p, err := managedproxy.Applied(profile, cfg.ProxyURL, cfg.ProxyRevision)
	if err != nil {
		return nil, &proxyUnavailableError{"所选代理尚未应用，更新检查将在代理就绪后重试"}
	}
	if !managedproxy.Running(ctx, profile, p) {
		return nil, &proxyUnavailableError{"所选代理未运行，更新检查将在代理就绪后重试；更新不会改用主机直连"}
	}
	egress, err := cage.NewEgress(cfg)
	if err != nil {
		return nil, errors.New("更新代理配置无效")
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: nil, DialContext: egress.DialContext, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 10 * time.Second},
		Timeout:   20 * time.Minute,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !allowedURL(r.URL, true) {
				return errors.New("更新下载重定向被拒绝")
			}
			return nil
		},
	}, nil
}

func allowedURL(u *url.URL, redirect bool) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "api.github.com":
		return u.Path == "/repos/"+repository+"/releases"
	case "github.com":
		return strings.HasPrefix(u.Path, "/"+repository+"/releases/download/") && !strings.Contains(u.Path, "/../")
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return redirect
	}
	return false
}

func request(ctx context.Context, client *http.Client, raw string) (*http.Response, error) {
	u, err := url.Parse(raw)
	if err != nil || !allowedURL(u, false) {
		return nil, errors.New("更新地址不属于 Cage 的受信发布源")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, errors.New("更新请求无效")
	}
	req.Header.Set("User-Agent", "Cage-Updater/"+version.Version)
	req.Header.Set("Accept", "application/vnd.github+json")
	if u.Hostname() == "api.github.com" {
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, errors.New("更新下载已取消")
		}
		return nil, usererror.Wrap("连接应用更新源", errors.Join(ctx.Err(), err), "请在网络与代理设置中确认所选节点可以连接 GitHub，再检查更新。")
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		switch resp.StatusCode {
		case 404:
			return nil, errors.New("更新源找不到请求的版本或安装包（HTTP 404）。请稍后检查更新；需要手动安装时，请核对 Cage 发布页面中的对应平台文件。")
		case 403, 429:
			return nil, updateSourceError(resp, time.Now())
		default:
			return nil, fmt.Errorf("更新源返回 HTTP %d，请稍后重试", resp.StatusCode)
		}
	}
	return resp, nil
}

func limitedBody(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	if resp.ContentLength > limit {
		return nil, errors.New("更新信息超过允许大小")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("更新信息下载中断或超过允许大小")
	}
	return b, nil
}

func findRelease(ctx context.Context, client *http.Client, current string) (*candidate, error) {
	resp, err := request(ctx, client, releasesURL)
	if err != nil {
		return nil, err
	}
	b, err := limitedBody(resp, maxMetadata)
	if err != nil {
		return nil, err
	}
	var releases []release
	if json.Unmarshal(b, &releases) != nil {
		return nil, errors.New("更新源返回了无效的版本信息")
	}
	return catalog.Select(releases, current, runtime.GOOS, runtime.GOARCH)
}

func releaseDigest(ctx context.Context, client *http.Client, c candidate) (string, error) {
	if c.Checksums.URL == "" {
		return c.SHA256(nil)
	}
	u, err := url.Parse(c.Checksums.URL)
	if err != nil || u.Hostname() != "github.com" || !strings.HasPrefix(u.Path, "/"+repository+"/releases/download/v"+c.Version+"/") {
		return "", errors.New("校验清单不属于同一发行版本")
	}
	resp, err := request(ctx, client, c.Checksums.URL)
	if err != nil {
		return "", err
	}
	b, err := limitedBody(resp, 64<<10)
	if err != nil {
		return "", err
	}
	return c.SHA256(b)
}

func download(ctx context.Context, client *http.Client, a asset, digest, path string, progress func(int64)) error {
	if a.Size <= 0 || a.Size > maxArchive {
		return errors.New("发行包大小无效或超过 512 MiB")
	}
	if _, err := catalog.DigestValue("sha256:" + digest); err != nil {
		return err
	}
	resp, err := request(ctx, client, a.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.ContentLength > 0 && resp.ContentLength != a.Size {
		return errors.New("发行包大小与发布信息不一致")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("无法创建私有更新文件")
	}
	keep := false
	defer func() {
		f.Close()
		if !keep {
			os.Remove(path)
		}
	}()
	if err := host.ProtectFile(path); err != nil {
		return errors.New("无法保护更新文件")
	}
	hash := sha256.New()
	w := &progressWriter{writer: io.MultiWriter(f, hash), notify: progress}
	n, err := io.Copy(w, io.LimitReader(resp.Body, a.Size+1))
	if err != nil || n != a.Size {
		return errors.New("发行包下载中断或实际大小不匹配")
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("发行包 SHA-256 校验失败，请重新下载")
	}
	if err = f.Sync(); err != nil {
		return errors.New("无法保存更新文件")
	}
	if err = f.Close(); err != nil {
		return errors.New("无法保存更新文件")
	}
	keep = true
	progress(n)
	return nil
}

type progressWriter struct {
	writer io.Writer
	notify func(int64)
	total  int64
	last   time.Time
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.total += int64(n)
	if time.Since(w.last) >= 250*time.Millisecond {
		w.last = time.Now()
		w.notify(w.total)
	}
	return n, err
}
