//go:build !unix && !windows

package datalock

// lockFile on a platform without either lock (plan9, wasm): no lock, so two
// processes on one data directory are not prevented there.
func lockFile(string) (func() error, error) { return func() error { return nil }, nil }
