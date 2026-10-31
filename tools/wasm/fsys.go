package main

import (
	"io/fs"
	"strings"
)

// slashFS lets the interpreter's filepath-joined names (backslashes on
// Windows) find files in an in-memory fs.FS, so the native build used for
// testing behaves like the js/wasm build.
type slashFS struct{ fs.FS }

func clean(name string) string { return strings.ReplaceAll(name, "\\", "/") }

func (s slashFS) Open(name string) (fs.File, error) { return s.FS.Open(clean(name)) }

func (s slashFS) Stat(name string) (fs.FileInfo, error) { return fs.Stat(s.FS, clean(name)) }

func (s slashFS) ReadDir(name string) ([]fs.DirEntry, error) { return fs.ReadDir(s.FS, clean(name)) }

func (s slashFS) ReadFile(name string) ([]byte, error) { return fs.ReadFile(s.FS, clean(name)) }
