package hostimage

import (
	"context"
	"errors"
	"sync"
	"time"
)

var errDownloadIdle = errors.New("系统下载长时间未收到数据，请检查网络后继续安装")

// Bound a stalled response without imposing a short total deadline on large
// images. Received bytes renew activity; cancellation leaves the partial file.
func watchDownload(parent context.Context) (context.Context, func(), func()) {
	const idle = time.Minute
	ctx, cancel := context.WithCancelCause(parent)
	var mu sync.Mutex
	last := time.Now()
	stopped := false
	var timer *time.Timer
	var check func()
	check = func() {
		mu.Lock()
		defer mu.Unlock()
		if stopped {
			return
		}
		if remaining := idle - time.Since(last); remaining > 0 {
			timer.Reset(remaining)
			return
		}
		cancel(errDownloadIdle)
	}
	timer = time.AfterFunc(idle, check)
	touch := func() {
		mu.Lock()
		last = time.Now()
		mu.Unlock()
	}
	stop := func() {
		mu.Lock()
		stopped = true
		timer.Stop()
		mu.Unlock()
		cancel(nil)
	}
	return ctx, touch, stop
}
