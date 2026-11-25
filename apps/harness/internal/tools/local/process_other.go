//go:build !unix

package local

import "os/exec"

// killGroupOnCancel: without process groups the cancel kills the shell; WaitDelay bounds the wait for its children.
func killGroupOnCancel(cmd *exec.Cmd) {}
