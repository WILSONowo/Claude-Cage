//go:build !windows

package managedproxy

func controlSocketForDial(profile string) (string, error) {
	return Socket(profile), nil
}
