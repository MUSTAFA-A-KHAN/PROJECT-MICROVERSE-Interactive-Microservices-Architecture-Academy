package main

import (
	"os"
	rdebug "runtime/debug"
)

// debugMode prints diagnostics on stderr (MICROVERSE_DEBUG=1, native builds).
var debugMode = os.Getenv("MICROVERSE_DEBUG") != ""

func debugStack() []byte { return rdebug.Stack() }
