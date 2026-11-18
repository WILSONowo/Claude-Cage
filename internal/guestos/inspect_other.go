//go:build !darwin && !linux && !windows

package guestos

import "context"

func Inspect(_ context.Context) Inspection {
	return Inspection{WorkbenchSupport: "unsupported-host", Detail: "此平台不支持在本机运行 Cage 环境。"}
}
