// SPDX-FileCopyrightText: Copyright The Lima Authors
// SPDX-License-Identifier: Apache-2.0

package instance

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/lima-vm/lima/v2/pkg/limatype"
)

func TestLinuxBaseProvisioningWait(t *testing.T) {
	for _, tc := range []struct {
		name                string
		sample              func(int64) (int64, bool)
		ordinary, cancelled bool
		elapsed             time.Duration
		cause               string
	}{
		{"growing downloads hit hard limit", func(n int64) (int64, bool) { return n, true }, false, false, time.Hour, "初始化超过"},
		{"unchanged files stop", func(n int64) (int64, bool) { return 512, true }, false, false, 10 * time.Minute, "没有观察到"},
		{"unreachable guest stops", func(n int64) (int64, bool) { return 0, false }, false, false, 10 * time.Minute, "没有观察到"},
		{"ordinary boot keeps its deadline", nil, true, false, 10 * time.Minute, ""},
		{"parent cancels while probe is running", nil, false, true, 30 * time.Second, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				parent, cancel := context.WithCancel(t.Context())
				defer cancel()
				var polls int64
				if !tc.ordinary {
					policy := baseProvisioningWatch{30 * time.Second, time.Hour, func(ctx context.Context, _ *limatype.Instance) (int64, bool) {
						polls++
						if tc.cancelled {
							cancel()
							<-ctx.Done()
							return 0, false
						}
						return tc.sample(polls)
					}}
					parent = context.WithValue(parent, baseProvisioningKey{}, policy)
				}
				linux := limatype.LINUX
				start := time.Now()
				ctx, stop := hostAgentWatchContext(parent, &limatype.Instance{Config: &limatype.LimaYAML{OS: &linux}}, nil)
				defer stop()
				<-ctx.Done()
				if elapsed := time.Since(start); elapsed != tc.elapsed {
					t.Fatalf("waited %s, want %s", elapsed, tc.elapsed)
				}
				reason := context.DeadlineExceeded
				if tc.cancelled {
					reason = context.Canceled
				}
				if err := context.Cause(ctx); !errors.Is(err, reason) || !strings.Contains(err.Error(), tc.cause) {
					t.Fatalf("wrong cause %v", err)
				}
			})
		})
	}
}

func TestLinuxBaseProvisioningBootEvents(t *testing.T) {
	linux, plain := limatype.LINUX, true
	inst := &limatype.Instance{Config: &limatype.LimaYAML{OS: &linux, Plain: &plain}}
	for _, tc := range []struct{ name, status, want string }{
		{"ready", `{"running":true}`, ""},
		{"failure", `{"exiting":true,"errors":["guest boot failed"]}`, "guest boot failed"},
		{"degraded", `{"running":true,"degraded":true}`, "degraded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			stdout, stderr := filepath.Join(dir, "ha.stdout.log"), filepath.Join(dir, "ha.stderr.log")
			if err := os.WriteFile(stdout, []byte(`{"status":`+tc.status+"}\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(stderr, nil, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			err := watchHostAgentEvents(WithLinuxBaseProvisioning(ctx), inst, stdout, stderr, time.Time{}, false)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %s", err, tc.want)
			}
		})
	}
}

func TestCloudInitOutputExtendsIdleWithoutAPTActivity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		linux := limatype.LINUX
		policy := baseProvisioningWatch{time.Minute, time.Hour, func(context.Context, *limatype.Instance) (int64, bool) { return 0, false }}
		parent := context.WithValue(t.Context(), baseProvisioningKey{}, policy)
		progress := make(chan struct{}, 1)
		ctx, stop := hostAgentWatchContext(parent, &limatype.Instance{Config: &limatype.LimaYAML{OS: &linux}}, progress)
		defer stop()
		for i := 0; i < 3; i++ {
			time.Sleep(8 * time.Minute)
			if ctx.Err() != nil {
				t.Fatalf("active cloud-init timed out: %v", context.Cause(ctx))
			}
			progress <- struct{}{}
			synctest.Wait()
		}
		idleAt := time.Now()
		<-ctx.Done()
		if time.Since(idleAt) != 10*time.Minute || !errors.Is(context.Cause(ctx), context.DeadlineExceeded) {
			t.Fatalf("stalled cloud-init: %s %v", time.Since(idleAt), context.Cause(ctx))
		}
	})
}
