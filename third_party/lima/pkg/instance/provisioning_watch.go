// SPDX-FileCopyrightText: Copyright The Lima Authors
// SPDX-License-Identifier: Apache-2.0

package instance

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/lima-vm/lima/v2/pkg/limatype"
	"github.com/lima-vm/lima/v2/pkg/sshutil"
)

type baseProvisioningKey struct{}

type baseProvisioningWatch struct {
	interval, limit time.Duration
	sample          func(context.Context, *limatype.Instance) (int64, bool)
}

// WithLinuxBaseProvisioning allows a base template's first Linux boot to keep
// fetching packages. Ordinary starts use the normal hostagent timeout.
func WithLinuxBaseProvisioning(ctx context.Context) context.Context {
	return context.WithValue(ctx, baseProvisioningKey{}, baseProvisioningWatch{30 * time.Second, time.Hour, aptPartialBytes})
}

// APT may spend minutes on a single index without writing a cloud-init log
// line. Read only numeric sizes of in-flight files using this VM's SSH config.
// find runs as root because _apt owns the private partial directories.
const aptPartialCommand = "sudo -n find /var/lib/apt/lists/partial /var/cache/apt/archives/partial -maxdepth 1 -type f -printf '%s\\n' 2>/dev/null | awk '{n+=$1} END {printf \"%.0f\\n\", n}'"

func aptPartialBytes(ctx context.Context, inst *limatype.Instance) (int64, bool) {
	ssh, err := sshutil.NewSSHExe()
	if err != nil {
		return 0, false
	}
	args := append(ssh.Args, "-F", inst.SSHConfigFile, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", inst.Hostname, aptPartialCommand)
	cmd := exec.CommandContext(ctx, ssh.Exe, args...)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	return n, err == nil && n >= 0
}

func hostAgentWatchContext(parent context.Context, inst *limatype.Instance, progress <-chan struct{}) (context.Context, context.CancelFunc) {
	idle := watchHostAgentTimeout(parent)
	policy, enabled := parent.Value(baseProvisioningKey{}).(baseProvisioningWatch)
	if !enabled || inst.Config.OS == nil || *inst.Config.OS != limatype.LINUX {
		return context.WithTimeout(parent, idle)
	}
	deadline, stopDeadline := context.WithTimeoutCause(parent, policy.limit,
		fmt.Errorf("Linux 基础环境初始化超过 %s: %w", policy.limit, context.DeadlineExceeded))
	ctx, cancel := context.WithCancelCause(deadline)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticks := time.NewTicker(policy.interval)
		defer ticks.Stop()
		idleTimer := time.NewTimer(idle)
		defer idleTimer.Stop()
		var previous int64 = -1
		for {
			select {
			case <-ctx.Done():
				return
			case <-progress:
				idleTimer.Reset(idle)
			case <-idleTimer.C:
				cancel(fmt.Errorf("Linux 基础环境未就绪，连续 %s 没有观察到 cloud-init 输出或 APT 下载进度: %w", idle, context.DeadlineExceeded))
				return
			case <-ticks.C:
				probe, stop := context.WithTimeout(ctx, 5*time.Second)
				n, ok := policy.sample(probe, inst)
				stop()
				if !ok {
					continue
				}
				changed := previous >= 0 && n != previous && n > 0
				previous = n
				if changed {
					idleTimer.Reset(idle)
					logrus.Infof("正在下载 Linux 基础依赖，APT 临时文件合计 %d 字节", n)
				}
			}
		}
	}()
	return ctx, func() {
		cancel(context.Canceled)
		stopDeadline()
		<-done
	}
}
