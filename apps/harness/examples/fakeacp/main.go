// Command fakeacp is a scripted ACP agent for demos and tests; see
// internal/fakeacp for the prompt markers that switch its behaviour.
package main

import (
	"os"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

func main() { os.Exit(fakeacp.Main()) }
