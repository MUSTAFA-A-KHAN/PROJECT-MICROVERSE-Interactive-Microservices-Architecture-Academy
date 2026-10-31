//go:build js && wasm

package main

import (
	"encoding/json"
	"os"
	"syscall/js"
)

// One job per WebAssembly instance (the Code Lab starts a fresh worker for
// every run, so a crash, os.Exit or runaway goroutine can't leak into the
// next one). The job is a JSON string in globalThis.__mvJob; progress and
// results are reported through globalThis.__mvEvent(kind, payload).
type job struct {
	Mode  string            `json:"mode"` // "run" | "fmt" | "syntax"
	Files map[string]string `json:"files"`
	Name  string            `json:"name"`
	Src   string            `json:"src"`
}

func emit(kind string, v any) {
	b, _ := json.Marshal(v)
	js.Global().Call("__mvEvent", kind, string(b))
}

func main() {
	var j job
	if err := json.Unmarshal([]byte(js.Global().Get("__mvJob").String()), &j); err != nil {
		emit("result", map[string]string{"error": "bad job: " + err.Error()})
		return
	}
	switch j.Mode {
	case "run":
		res := Run(j.Files, os.Stdout, os.Stderr, func(p string) { emit("phase", p) })
		emit("done", res)
		os.Exit(res.ExitCode)
	case "fmt":
		out, err := Format(j.Src)
		if err != nil {
			emit("result", map[string]string{"error": err.Error()})
			return
		}
		emit("result", map[string]string{"code": out})
	case "syntax":
		emit("result", map[string]any{"diags": Syntax(j.Name, j.Src)})
	default:
		emit("result", map[string]string{"error": "unknown mode " + j.Mode})
	}
}
