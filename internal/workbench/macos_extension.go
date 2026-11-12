package workbench

import (
	"context"
	_ "embed"
	"errors"
	"os/exec"
	"strings"
	"time"
)

//go:embed macos_extension_probe.pl
var macOSProbeFSKit string

func (s *Server) checkMacOSSetupProjects(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	cmd := s.macOSSSHCommand(ctx, "-T", s.sshTarget(), "--", "exec /usr/bin/perl -")
	cmd.Stdin = strings.NewReader(macOSProbeFSKit)
	err := cmd.Run()
	s.mu.Lock()
	if err != nil {
		s.macSetupProjectsChecked = time.Time{}
	} else {
		s.macSetupProjectsChecked = time.Now()
	}
	s.mu.Unlock()
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("文件共享挂载检测超时，请重新检查状态")
		}
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			switch exited.ExitCode() {
			case 2:
				return errors.New("文件共享测试卷已挂载，但卸载失败。扩展授权已生效，请重新检查状态")
			case 3:
				return errors.New("文件共享测试的临时目录未能清理，请重新检查状态")
			}
		}
		return errors.New("文件共享挂载测试未通过。请确认 macFUSE 和 macFUSE (local) 两个文件系统扩展均已打开，再重新检查状态")
	}
	return nil
}
