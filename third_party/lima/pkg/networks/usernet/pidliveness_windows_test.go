// SPDX-FileCopyrightText: Copyright The Lima Authors
// SPDX-License-Identifier: Apache-2.0

package usernet

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestUsernetPIDSharingViolation(t *testing.T) {
	t.Setenv("LIMA_HOME", t.TempDir())
	name := "fixture"
	path, err := PIDFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte(fmt.Sprint(os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(ptr, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	for _, run := range []func(context.Context, string) error{Stop, Start} {
		if err = run(t.Context(), name); !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			t.Fatalf("unreadable live owner: %v", err)
		}
	}
}
