//go:build !js

// Native build of the runner, used by tools/check-exercises.mjs to verify the
// exercises against the same interpreter the browser uses:
//
//	go run . run  <dir>     run every *.go file in dir as package main
//	go run . fmt  <file>    gofmt a file
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: runner run <dir> | fmt <file>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "run":
		files := map[string]string{}
		entries, err := os.ReadDir(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".go") {
				b, _ := os.ReadFile(filepath.Join(os.Args[2], e.Name()))
				files[e.Name()] = string(b)
			}
		}
		res := Run(files, os.Stdout, os.Stderr, func(p string) { fmt.Fprintln(os.Stderr, "##phase", p) })
		os.Exit(res.ExitCode)
	case "fmt":
		b, _ := os.ReadFile(os.Args[2])
		out, err := Format(string(b))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Print(out)
	}
}
