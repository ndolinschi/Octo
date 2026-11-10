package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(os.Args[2:])
	case "sessions":
		err = cmdSessions(os.Args[2:])
	case "show":
		err = cmdShow(os.Args[2:])
	case "serve":
		err = cmdServe(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, "usage:\n")
	fmt.Fprintf(os.Stderr, "  harness serve [--addr HOST:PORT] [--data-dir PATH] [--base-url URL] [flags]\n")
	fmt.Fprintf(os.Stderr, "  harness run --prompt \"...\" [flags]\n")
	fmt.Fprintf(os.Stderr, "  harness sessions [--data-dir PATH]\n")
	fmt.Fprintf(os.Stderr, "  harness show <session-id> [--data-dir PATH]\n")
}

type multiFlag []string

func (m *multiFlag) String() string {
	return ""
}

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}
