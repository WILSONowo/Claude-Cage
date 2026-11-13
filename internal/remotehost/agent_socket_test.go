package remotehost

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"golang.org/x/crypto/ssh/agent"
	"net"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestHostAgentSocket(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	path := filepath.Join(dir, "agent.sock")
	profile := HostProfile{Name: "build", User: "cage", Host: "localhost", Auth: AuthConfig{Kind: "agent"}}
	for _, invalid := range []string{"relative.sock", path + "\n"} {
		profile.Auth.AgentSocket = invalid
		if _, err := store.Upsert(profile); err == nil {
			t.Fatal("accepted invalid socket", invalid)
		}
	}
	if runtime.GOOS == "windows" {
		if validAgentSocket(`\\remote\pipe\agent`) || !validAgentSocket(`\\.\pipe\openssh-ssh-agent`) {
			t.Fatal("local named pipe validation")
		}
	}
	profile.Auth.AgentSocket = path
	saved, err := store.Upsert(profile)
	if err != nil {
		t.Fatal(err)
	}
	hosts, err := NewStore(dir).List()
	if err != nil || len(hosts) != 1 || hosts[0].Auth != saved.Auth {
		t.Fatal("saved socket not restored", err)
	}
	profile.Auth.Kind = "key_file"
	profile.Auth.IdentityFile = filepath.Join(dir, "key")
	normalized, err := normalizeProfile(profile)
	if err != nil || normalized.Auth.AgentSocket != "" {
		t.Fatal("key file retained agent socket", err)
	}
}

func TestAgentAuthenticationUsesSelectedSocket(t *testing.T) {
	// Windows AF_UNIX and Linux have short pathname limits; keep the socket near the temp root.
	path := filepath.Join(t.TempDir(), "a")
	if runtime.GOOS != "windows" && len(path) > 100 {
		t.Fatal("fixture socket path too long")
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	empty := agent.NewKeyring()
	populated := agent.NewKeyring()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := populated.Add(agent.AddedKey{PrivateKey: key}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		ring     agent.Agent
		explicit bool
		want     string
	}{
		{"explicit", populated, true, ""}, {"environment", populated, false, ""}, {"empty", empty, true, "没有可用密钥"}, {"protocol", nil, true, "无法读取"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("SSH_AUTH_SOCK", path)
			auth := AuthConfig{Kind: "agent"}
			if test.explicit {
				t.Setenv("SSH_AUTH_SOCK", filepath.Join(filepath.Dir(path), "absent"))
				auth.AgentSocket = path
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				if test.ring != nil {
					_ = agent.ServeAgent(test.ring, conn)
				}
			}()
			_, closeAgent, err := authentication(context.Background(), HostProfile{Auth: auth}, ConnectSecrets{})
			if closeAgent != nil {
				closeAgent()
			}
			if test.want == "" && err != nil || test.want != "" && (err == nil || !strings.Contains(err.Error(), test.want)) {
				t.Fatalf("error = %v", err)
			}
			<-done
		})
	}
}
