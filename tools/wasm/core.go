// Package main is the Microverse in-browser Go runner.
//
// Compiled to WebAssembly (GOOS=js GOARCH=wasm) it lets the Code Lab run Go
// without any server: programs are interpreted by Yaegi
// (github.com/traefik/yaegi), and go/parser, go/types and go/format supply the
// compile errors and gofmt that the real toolchain would report.
//
// Yaegi is an interpreter, not the gc compiler. The gaps that matter for the
// course are closed here, without changing line numbers in user code:
//   - gc rejects unused variables and imports and missing returns; Yaegi does
//     not, so a go/types pass reports those errors first. Other type errors
//     are reported in gc's words when the interpreter rejects the program too.
//   - Go 1.22 gave every loop iteration its own variables; loops are rewritten
//     to copy their variables per iteration.
//   - Yaegi creates the closure of "defer func() {...}()" when the function
//     returns, not at the defer statement; inside loops such defers are
//     rewritten so the closure is created where Go creates it.
//   - Go 1.21's min and max builtins are rewritten into calls to
//     type-specific helpers (or folded when constant).
package main

import (
	"bytes"
	"errors"
	"fmt"
	"go/ast"
	"go/constant"
	"go/format"
	"go/parser"
	"go/scanner"
	"go/token"
	"go/types"
	"io"
	"os"
	"path"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing/fstest"

	"github.com/traefik/yaegi/interp"
	"github.com/traefik/yaegi/stdlib"
)

// Diag is one compile-time problem, reported like the go command does.
type Diag struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Col     int    `json:"col"`
	Message string `json:"message"`
}

func (d Diag) String() string { return fmt.Sprintf("./%s:%d:%d: %s", d.File, d.Line, d.Col, d.Message) }

// fileOrder puts files in a stable order with main.go last.
func fileOrder(files map[string]string) []string {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		if (names[i] == "main.go") != (names[j] == "main.go") {
			return names[j] == "main.go"
		}
		return names[i] < names[j]
	})
	return names
}

func syntaxDiags(name string, err error) []Diag {
	var list scanner.ErrorList
	if !errors.As(err, &list) {
		return []Diag{{File: name, Line: 1, Col: 1, Message: err.Error()}}
	}
	var diags []Diag
	for i, e := range list {
		if i == 10 {
			break
		}
		diags = append(diags, Diag{File: name, Line: e.Pos.Line, Col: e.Pos.Column, Message: "syntax error: " + e.Msg})
	}
	return diags
}

// gcOnly reports errors the go command enforces but the interpreter ignores.
func gcOnly(msg string) bool {
	return strings.Contains(msg, "declared and not used") || strings.Contains(msg, "imported and not used") || msg == "missing return"
}

// Checked is the outcome of parsing and type-checking a program.
type Checked struct {
	Fset     *token.FileSet
	Files    []*ast.File
	Info     *types.Info
	Blocking []Diag // syntax errors and gc-only errors: the program must not run
	Advisory []Diag // other type errors, in gc's words
}

// Check parses and type-checks a package main.
func Check(files map[string]string) Checked {
	c := Checked{Fset: token.NewFileSet()}
	for _, name := range fileOrder(files) {
		f, err := parser.ParseFile(c.Fset, name, files[name], parser.ParseComments|parser.AllErrors)
		if err != nil {
			c.Blocking = append(c.Blocking, syntaxDiags(name, err)...)
			continue
		}
		c.Files = append(c.Files, f)
	}
	if len(c.Blocking) > 0 {
		return c
	}
	if !c.typecheck(newBridge()) {
		// The bridge tripped over something: fall back to a checker that only
		// knows package names, which still finds unused variables and imports.
		c.Blocking, c.Advisory = nil, nil
		c.typecheck(fakeImporter{})
		c.Advisory = nil
	}
	sortDiags(c.Blocking)
	sortDiags(c.Advisory)
	return c
}

func (c *Checked) typecheck(imp types.Importer) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			if debugMode {
				fmt.Fprintf(os.Stderr, "type checker failed, falling back: %v\n%s", r, debugStack())
			}
			ok = false
		}
	}()
	c.Info = &types.Info{
		Types:      map[ast.Expr]types.TypeAndValue{},
		Uses:       map[*ast.Ident]types.Object{},
		Defs:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
		Instances:  map[*ast.Ident]types.Instance{},
	}
	conf := types.Config{
		Importer: imp,
		Error: func(err error) {
			te, ok := err.(types.Error)
			if !ok {
				return
			}
			p := c.Fset.Position(te.Pos)
			d := Diag{File: p.Filename, Line: p.Line, Col: p.Column, Message: te.Msg}
			if gcOnly(te.Msg) {
				c.Blocking = append(c.Blocking, d)
			} else if len(c.Advisory) < 10 {
				c.Advisory = append(c.Advisory, d)
			}
		},
	}
	conf.Check("main", c.Fset, c.Files, c.Info)
	return true
}

func sortDiags(d []Diag) {
	sort.SliceStable(d, func(i, j int) bool {
		if d[i].File != d[j].File {
			return d[i].File < d[j].File
		}
		return d[i].Line < d[j].Line
	})
}

type fakeImporter struct{}

var versionSuffix = regexp.MustCompile(`^v[0-9]+$`)

func (fakeImporter) Import(p string) (*types.Package, error) {
	pkg := types.NewPackage(p, defaultName(p))
	pkg.MarkComplete()
	return pkg, nil
}

// defaultName is the package name an import path usually declares.
func defaultName(p string) string {
	name := path.Base(p)
	if versionSuffix.MatchString(name) {
		name = path.Base(path.Dir(p))
	}
	return name
}

type edit struct {
	from, to int // byte offsets; from == to inserts
	text     string
}

// helpers collects the type-specific functions that replace min and max.
type helpers struct {
	imports map[string]string // import path → alias in zz_microverse.go
	funcs   map[string]string // "min|T" → function name
	src     strings.Builder
}

func (h *helpers) qualifier(p *types.Package) string {
	if p.Path() == "main" {
		return ""
	}
	if a, ok := h.imports[p.Path()]; ok {
		return a
	}
	a := fmt.Sprintf("zzp%d", len(h.imports)+1)
	h.imports[p.Path()] = a
	return a
}

func (h *helpers) minmax(op string, t types.Type) string {
	ts := types.TypeString(t, h.qualifier)
	key := op + "|" + ts
	if name, ok := h.funcs[key]; ok {
		return name
	}
	name := fmt.Sprintf("zz%s%d", op, len(h.funcs)+1)
	h.funcs[key] = name
	cmp := "<"
	if op == "max" {
		cmp = ">"
	}
	fmt.Fprintf(&h.src, "\nfunc %s(x %s, ys ...%s) %s {\n\tfor _, y := range ys {\n\t\tif y %s x {\n\t\t\tx = y\n\t\t}\n\t}\n\treturn x\n}\n", name, ts, ts, ts, cmp)
	return name
}

func (h *helpers) file() string {
	var b strings.Builder
	b.WriteString("package main\n\nimport zzrt \"microverse/rt\"\nimport zzfmt \"fmt\"\nimport zzerrors \"errors\"\nimport zzreflect \"reflect\"\n")
	paths := make([]string, 0, len(h.imports))
	for p := range h.imports {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		fmt.Fprintf(&b, "import %s %q\n", h.imports[p], p)
	}
	b.WriteString(`
// Runs after the program has compiled, before main.
func init() { zzrt.Started() }

func zzDefer(f func()) { f() }

func zzErr(e error) error { return e }

func zzStr(s zzfmt.Stringer) zzfmt.Stringer { return s }

// zzAs walks an error tree like errors.As, matching with a type assertion.
func zzAs(err error, match func(error) bool) bool {
	for err != nil {
		if match(err) {
			return true
		}
		// Standard-library wrappers (fmt.Errorf's %w, errors.Join) are
		// unwrapped natively; the program's own types by type assertion.
		if next := zzerrors.Unwrap(err); next != nil {
			err = next
			continue
		}
		if m := zzreflect.ValueOf(err).MethodByName("Unwrap"); m.IsValid() && m.Type().NumIn() == 0 && m.Type().NumOut() == 1 {
			if list, ok := m.Call(nil)[0].Interface().([]error); ok {
				for _, e := range list {
					if zzAs(e, match) {
						return true
					}
				}
				return false
			}
		}
		if u, ok := err.(interface{ Unwrap() error }); ok {
			err = u.Unwrap()
			continue
		}
		if u, ok := err.(interface{ Unwrap() []error }); ok {
			for _, e := range u.Unwrap() {
				if zzAs(e, match) {
					return true
				}
			}
		}
		return false
	}
	return false
}
`)
	b.WriteString(h.src.String())
	return b.String()
}

// Rewrite adapts one file for the interpreter (see the package comment).
// Every edit stays on its original line, so positions in errors are unchanged.
func Rewrite(c Checked, f *ast.File, src string, h *helpers) string {
	off := func(p token.Pos) int { return c.Fset.Position(p).Offset }
	var edits []edit
	var loops int // loop bodies enclosing the current node (within one function)

	// Local import names, to spell typed constants in this file.
	local := map[string]string{}
	for _, spec := range f.Imports {
		p, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			continue
		}
		switch {
		case spec.Name == nil:
			local[p] = defaultName(p)
		case spec.Name.Name != "_" && spec.Name.Name != ".":
			local[p] = spec.Name.Name
		}
	}
	localQual := func(p *types.Package) string {
		if p.Path() == "main" {
			return ""
		}
		return local[p.Path()]
	}

	params, switches := 0, 0
	labeled := map[*ast.TypeSwitchStmt]bool{}
	// nameParams gives unnamed and blank parameters a name: the interpreter
	// copies arguments into the wrong frame slots when a function literal has
	// unnamed parameters.
	nameParams := func(fl *ast.FieldList) {
		if fl == nil {
			return
		}
		for _, field := range fl.List {
			if len(field.Names) == 0 {
				params++
				edits = append(edits, edit{from: off(field.Type.Pos()), to: off(field.Type.Pos()), text: fmt.Sprintf("zzp%d ", params)})
				continue
			}
			for _, id := range field.Names {
				if id.Name == "_" {
					params++
					edits = append(edits, edit{from: off(id.Pos()), to: off(id.End()), text: fmt.Sprintf("zzp%d", params)})
				}
			}
		}
	}

	var visit func(n ast.Node) bool
	visit = func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.FuncDecl:
			nameParams(s.Recv)
			nameParams(s.Type.Params)
			return true
		case *ast.LabeledStmt:
			if ts, ok := s.Stmt.(*ast.TypeSwitchStmt); ok {
				labeled[ts] = true // break/continue Label must keep targeting a switch
			}
			return true
		case *ast.TypeSwitchStmt:
			if !labeled[s] {
				switches++
				edits = append(edits, typeSwitch(s, src, off, switches)...)
			}
			for _, part := range []ast.Node{s.Init, s.Assign} {
				if part != nil {
					ast.Inspect(part, visit)
				}
			}
			for _, cl := range s.Body.List {
				for _, st := range cl.(*ast.CaseClause).Body {
					ast.Inspect(st, visit)
				}
			}
			return false
		case *ast.FuncLit:
			nameParams(s.Type.Params)
			saved := loops
			loops = 0
			ast.Inspect(s.Body, visit)
			loops = saved
			return false
		case *ast.RangeStmt, *ast.ForStmt:
			names, body := loopVars(s)
			if len(names) > 0 {
				var b strings.Builder
				for _, name := range names {
					fmt.Fprintf(&b, " %s := %s; _ = %s;", name, name, name)
				}
				edits = append(edits, edit{from: off(body.Lbrace) + 1, to: off(body.Lbrace) + 1, text: b.String()})
			}
			if r, ok := s.(*ast.RangeStmt); ok {
				edits = append(edits, rangeOverInt(c, r, localQual, off)...)
				ast.Inspect(r.X, visit)
				body = r.Body
			} else {
				fs := s.(*ast.ForStmt)
				for _, part := range []ast.Node{fs.Init, fs.Cond, fs.Post} {
					if part != nil {
						ast.Inspect(part, visit)
					}
				}
				body = fs.Body
			}
			loops++
			ast.Inspect(body, visit)
			loops--
			return false
		case *ast.DeferStmt:
			call := s.Call
			if len(call.Args) == 0 {
				if lit, ok := call.Fun.(*ast.FuncLit); ok && loops > 0 && noParams(lit.Type) && !callsRecover(lit.Body) {
					// defer func() {...}()  →  defer zzDefer(func() {...})
					edits = append(edits, edit{from: off(lit.Pos()), to: off(lit.Pos()), text: "zzDefer("})
					edits = append(edits, edit{from: off(call.Lparen), to: off(call.Rparen) + 1, text: ")"})
				} else if id, ok := call.Fun.(*ast.Ident); ok && isPlainFunc(c.Info, id) {
					// defer f()  →  defer zzDefer(f)   (f a func() variable)
					edits = append(edits, edit{from: off(id.Pos()), to: off(id.Pos()), text: "zzDefer("})
					edits = append(edits, edit{from: off(call.Lparen), to: off(call.Rparen) + 1, text: ")"})
				}
			}
			return true
		case *ast.CallExpr:
			edits = append(edits, methodfulArgs(c, s, off)...)
			edits = append(edits, typeArgs(c, s, localQual, off)...)
			if e := errorsAs(c, s, localQual, off); e != nil {
				edits = append(edits, e...)
				return true
			}
			id, ok := s.Fun.(*ast.Ident)
			if !ok || (id.Name != "min" && id.Name != "max") {
				return true
			}
			if _, builtin := c.Info.Uses[id].(*types.Builtin); !builtin {
				return true
			}
			tv := c.Info.Types[s]
			if tv.Type == nil || tv.Type == types.Typ[types.Invalid] {
				return true
			}
			if tv.Value != nil {
				if lit := constExpr(tv, localQual); lit != "" {
					edits = append(edits, edit{from: off(s.Pos()), to: off(s.End()), text: lit})
					return false
				}
				return true
			}
			edits = append(edits, edit{from: off(id.Pos()), to: off(id.End()), text: h.minmax(id.Name, tv.Type)})
			return true
		}
		return true
	}
	ast.Inspect(f, visit)

	if len(edits) == 0 {
		return src
	}
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].from > edits[j].from })
	out := src
	for _, e := range edits {
		out = out[:e.from] + e.text + out[e.to:]
	}
	return out
}

var (
	errorIface    = types.Universe.Lookup("error").Type().Underlying().(*types.Interface)
	stringerIface = types.NewInterfaceType([]*types.Func{types.NewFunc(token.NoPos, nil, "String",
		types.NewSignatureType(nil, nil, nil, nil, types.NewTuple(types.NewVar(token.NoPos, nil, "", types.Typ[types.String])), false))}, nil).Complete()
)

// methodfulArgs wraps arguments like fmt.Errorf("%w", &MyError{}) or
// fmt.Println(status) as zzErr(...) / zzStr(...). When a value of a type the
// program defines is passed to a standard-library parameter of type any, the
// interpreter passes it without its methods, so fmt wouldn't call Error or
// String and %w wouldn't wrap. Passing it through a function that returns
// error or fmt.Stringer makes the interpreter pass a wrapper that has them
// (an inline conversion like error(x) doesn't).
func methodfulArgs(c Checked, call *ast.CallExpr, off func(token.Pos) int) []edit {
	if call.Ellipsis.IsValid() {
		return nil
	}
	sig, ok := c.Info.Types[call.Fun].Type.(*types.Signature)
	if !ok {
		return nil
	}
	// Standard-library calls, and the program's own ...any functions (which
	// usually forward to fmt, like a test's Errorf or a logger's Printf).
	// Plain any parameters of the program's functions are left alone, so type
	// switches inside them still see the concrete type.
	native := nativeCallee(c, call.Fun)
	if !native && !(sig.Variadic() && isEmptyInterface(sig.Params().At(sig.Params().Len()-1).Type().(*types.Slice).Elem())) {
		return nil
	}
	// Printf-style call: only arguments formatted with a verb that consults
	// Error/String may be wrapped (Printf("%d", status) must print a number).
	verbs, formatAt := []rune(nil), -1
	if n := sig.Params().Len(); sig.Variadic() && n >= 2 && strings.HasSuffix(funcName(call.Fun), "f") {
		if b, ok := sig.Params().At(n - 2).Type().(*types.Basic); ok && b.Kind() == types.String && len(call.Args) >= n-1 {
			formatAt = n - 2
			tv := c.Info.Types[call.Args[formatAt]]
			if tv.Value == nil || tv.Value.Kind() != constant.String {
				return nil
			}
			if verbs, ok = formatVerbs(constant.StringVal(tv.Value)); !ok {
				return nil
			}
		}
	}
	var edits []edit
	for i, arg := range call.Args {
		if !native && i < sig.Params().Len()-1 {
			continue
		}
		methodVerb := true
		if formatAt >= 0 {
			k := i - formatAt - 1
			if k < 0 || k >= len(verbs) {
				continue
			}
			methodVerb = strings.ContainsRune("vsqxXw", verbs[k])
		}
		var pt types.Type
		switch n := sig.Params().Len(); {
		case sig.Variadic() && i >= n-1:
			pt = sig.Params().At(n - 1).Type().(*types.Slice).Elem()
		case i < n:
			pt = sig.Params().At(i).Type()
		default:
			continue
		}
		if iface, ok := pt.Underlying().(*types.Interface); !ok || !iface.Empty() {
			continue
		}
		at := c.Info.Types[arg].Type
		if at == nil || types.IsInterface(at) || !definedInMain(at) {
			continue
		}
		wrap := ""
		switch {
		case !methodVerb:
			// e.g. %d of a Status with a String method: format the number, as
			// Go does (the interpreter would print its internal representation).
			b, ok := at.Underlying().(*types.Basic)
			if !ok || types.NewMethodSet(at).Len() == 0 {
				continue
			}
			wrap = b.Name() + "("
		case types.Implements(at, errorIface):
			wrap = "zzErr("
		case types.Implements(at, stringerIface):
			wrap = "zzStr("
		default:
			continue
		}
		edits = append(edits, edit{from: off(arg.Pos()), to: off(arg.Pos()), text: wrap}, edit{from: off(arg.End()), to: off(arg.End()), text: ")"})
	}
	return edits
}

func funcName(fun ast.Expr) string {
	switch f := fun.(type) {
	case *ast.SelectorExpr:
		return f.Sel.Name
	case *ast.Ident:
		return f.Name
	}
	return ""
}

// formatVerbs lists the verb of each argument a format string consumes.
// It gives up (ok=false) on explicit argument indexes like %[2]d.
func formatVerbs(format string) (verbs []rune, ok bool) {
	rs := []rune(format)
	for i := 0; i < len(rs); i++ {
		if rs[i] != '%' {
			continue
		}
		i++
		for i < len(rs) && strings.ContainsRune("+-# 0123456789.*[]", rs[i]) {
			switch rs[i] {
			case '[':
				return nil, false
			case '*':
				verbs = append(verbs, 'd') // width/precision taken from an argument
			}
			i++
		}
		if i < len(rs) && rs[i] != '%' {
			verbs = append(verbs, rs[i])
		}
	}
	return verbs, true
}

func isEmptyInterface(t types.Type) bool {
	iface, ok := t.Underlying().(*types.Interface)
	return ok && iface.Empty()
}

// nativeCallee reports whether fun is a function or method of a standard-library package.
func nativeCallee(c Checked, fun ast.Expr) bool {
	sel, ok := fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	if x, ok := sel.X.(*ast.Ident); ok {
		if _, isPkg := c.Info.Uses[x].(*types.PkgName); isPkg {
			return true
		}
	}
	if s := c.Info.Selections[sel]; s != nil && s.Obj().Pkg() != nil {
		return s.Obj().Pkg().Path() != "main"
	}
	return false
}

// definedInMain reports whether t is (a pointer to) a named type the program declares.
func definedInMain(t types.Type) bool {
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	n, ok := t.(*types.Named)
	return ok && n.Obj().Pkg() != nil && n.Obj().Pkg().Path() == "main"
}

// errorsAs rewrites errors.As(err, target) into
// zzAs(err, func(e error) bool { v, ok := e.(T); if ok { *(target) = v }; return ok }).
// The standard library's errors.As inspects the target with reflection, which
// can't see the methods of types the interpreter defines, so it rejects
// targets like *MyError; a type assertion in interpreted code can.
func errorsAs(c Checked, call *ast.CallExpr, qual types.Qualifier, off func(token.Pos) int) []edit {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "As" || len(call.Args) != 2 {
		return nil
	}
	x, ok := sel.X.(*ast.Ident)
	if !ok {
		return nil
	}
	if pn, ok := c.Info.Uses[x].(*types.PkgName); !ok || pn.Imported().Path() != "errors" {
		return nil
	}
	ptr, ok := c.Info.Types[call.Args[1]].Type.(*types.Pointer)
	if !ok {
		return nil
	}
	t := types.TypeString(ptr.Elem(), qual)
	if strings.Contains(t, "/") {
		return nil
	}
	target := call.Args[1]
	return []edit{
		{from: off(call.Fun.Pos()), to: off(call.Fun.End()), text: "zzAs"},
		{from: off(target.Pos()), to: off(target.Pos()), text: fmt.Sprintf("func(zze error) bool { zzv, zzok := zze.(%s); if zzok { *(", t)},
		{from: off(target.End()), to: off(target.End()), text: ") = zzv }; return zzok }"},
	}
}

// typeArgs spells out inferred type arguments, Map(xs, f) → Map[int, string](xs, f):
// the interpreter's own type inference fails on many generic calls.
func typeArgs(c Checked, call *ast.CallExpr, qual types.Qualifier, off func(token.Pos) int) []edit {
	id, ok := call.Fun.(*ast.Ident) // explicit instantiations are IndexExprs, not Idents
	if !ok {
		return nil
	}
	inst, ok := c.Info.Instances[id]
	if !ok || inst.TypeArgs.Len() == 0 {
		return nil
	}
	if fn, ok := c.Info.Uses[id].(*types.Func); !ok || fn.Pkg() == nil || fn.Pkg().Path() != "main" {
		return nil
	}
	var args []string
	for i := 0; i < inst.TypeArgs.Len(); i++ {
		t := types.TypeString(inst.TypeArgs.At(i), qual)
		if strings.Contains(t, "/") || strings.Contains(t, "untyped") {
			return nil
		}
		args = append(args, t)
	}
	return []edit{{from: off(id.End()), to: off(id.End()), text: "[" + strings.Join(args, ", ") + "]"}}
}

// typeSwitch rewrites a type switch, which the interpreter matches
// unreliably, into comma-ok type assertions (which it gets right):
//
//	switch v := x.(type) {        {zzts1 := x; zzti1 := -1; if _, ok := zzts1.(A); ok { zzti1 = 0 } else if zzts1 == nil { zzti1 = 1 }; _ = zzts1; switch zzti1 {
//	case A:                       case 0: v := zzts1.(A); _ = v;
//	case nil, B:                  case 1: v := zzts1; _ = v;
//	default:                      default: v := zzts1; _ = v;
//	}                             }}
//
// Every replacement stays on its original line.
func typeSwitch(s *ast.TypeSwitchStmt, src string, off func(token.Pos) int, n int) []edit {
	var bind string
	var x ast.Expr
	switch a := s.Assign.(type) {
	case *ast.AssignStmt:
		bind = a.Lhs[0].(*ast.Ident).Name
		x = a.Rhs[0].(*ast.TypeAssertExpr).X
	case *ast.ExprStmt:
		x = a.X.(*ast.TypeAssertExpr).X
	default:
		return nil
	}
	if bind == "_" {
		bind = ""
	}
	text := func(e ast.Node) string { return src[off(e.Pos()):off(e.End())] }
	isNil := func(e ast.Expr) bool { id, ok := e.(*ast.Ident); return ok && id.Name == "nil" }
	ts, ti := fmt.Sprintf("zzts%d", n), fmt.Sprintf("zzti%d", n)

	// A nil interface is matched first: asserting on one crashes the interpreter.
	nilCase := -1
	var chain []string
	for i, cl := range s.Body.List {
		for _, t := range cl.(*ast.CaseClause).List {
			if isNil(t) {
				if nilCase < 0 {
					nilCase = i
				}
			} else {
				chain = append(chain, fmt.Sprintf("if _, zzok := %s.(%s); zzok { %s = %d }", ts, text(t), ti, i))
			}
		}
	}
	chain = append([]string{fmt.Sprintf("if %s == nil { %s = %d }", ts, ti, nilCase)}, chain...)
	a := s.Assign
	edits := []edit{
		{from: off(s.Switch), to: off(s.Switch) + len("switch"), text: "{"},
		{from: off(a.Pos()), to: off(x.Pos()), text: ts + " := "},
		{from: off(x.End()), to: off(a.End()), text: fmt.Sprintf("; %s := -1; %s; _ = %s; switch %s", ti, strings.Join(chain, " else "), ts, ti)},
		{from: off(s.Body.Rbrace) + 1, to: off(s.Body.Rbrace) + 1, text: "}"},
	}
	for i, cl := range s.Body.List {
		cc := cl.(*ast.CaseClause)
		head := fmt.Sprintf("case %d:", i)
		if cc.List == nil {
			head = "default:"
		}
		if bind != "" {
			if len(cc.List) == 1 && !isNil(cc.List[0]) {
				head += fmt.Sprintf(" %s := %s.(%s); _ = %s;", bind, ts, text(cc.List[0]), bind)
			} else {
				head += fmt.Sprintf(" %s := %s; _ = %s;", bind, ts, bind)
			}
		}
		edits = append(edits, edit{from: off(cc.Case), to: off(cc.Colon) + 1, text: head})
	}
	return edits
}

// rangeOverInt turns Go 1.22's "for i := range n" into
// "for i, zzN := T(0), T(n); i < zzN; i++", which the interpreter supports.
func rangeOverInt(c Checked, r *ast.RangeStmt, qual types.Qualifier, off func(token.Pos) int) []edit {
	tv := c.Info.Types[r.X]
	if tv.Type == nil || r.Tok == token.ASSIGN || r.Value != nil {
		return nil
	}
	b, ok := tv.Type.Underlying().(*types.Basic)
	if !ok || b.Info()&types.IsInteger == 0 {
		return nil
	}
	key := "zzK"
	if id, ok := r.Key.(*ast.Ident); ok && id.Name != "_" {
		key = id.Name
	}
	t := "int"
	if b.Info()&types.IsUntyped == 0 {
		t = types.TypeString(tv.Type, qual)
		if strings.Contains(t, "/") {
			return nil
		}
	}
	start := r.Range
	if r.Key != nil {
		start = r.Key.Pos()
	}
	return []edit{
		{from: off(start), to: off(r.X.Pos()), text: fmt.Sprintf("%s, zzN := %s(0), %s(", key, t, t)},
		{from: off(r.X.End()), to: off(r.X.End()), text: fmt.Sprintf("); %s < zzN; %s++", key, key)},
	}
}

// constExpr spells a constant min/max result, keeping its type.
func constExpr(tv types.TypeAndValue, qual types.Qualifier) string {
	v := tv.Value
	var lit string
	switch v.Kind() {
	case constant.Int:
		lit = v.ExactString()
	case constant.Float:
		f, _ := constant.Float64Val(v)
		lit = strconv.FormatFloat(f, 'g', -1, 64)
		if !strings.ContainsAny(lit, ".eE") {
			lit += ".0"
		}
	case constant.String:
		lit = strconv.Quote(constant.StringVal(v))
	default:
		return ""
	}
	if b, ok := tv.Type.(*types.Basic); ok && b.Info()&types.IsUntyped != 0 {
		if b.Kind() == types.UntypedRune {
			return "rune(" + lit + ")"
		}
		return "(" + lit + ")"
	}
	ts := types.TypeString(tv.Type, qual)
	if strings.Contains(ts, "/") {
		return "" // the type's package isn't imported by name in this file
	}
	return ts + "(" + lit + ")"
}

// loopVars returns the variables a loop declares that need a per-iteration
// copy. Three-clause loops whose body assigns to (or takes the address of) a
// loop variable are left alone: a copy would change their behaviour.
func loopVars(n ast.Node) ([]string, *ast.BlockStmt) {
	var names []string
	switch s := n.(type) {
	case *ast.RangeStmt:
		if s.Tok != token.DEFINE {
			return nil, s.Body
		}
		for _, e := range []ast.Expr{s.Key, s.Value} {
			if id, ok := e.(*ast.Ident); ok && id.Name != "_" {
				names = append(names, id.Name)
			}
		}
		return names, s.Body
	case *ast.ForStmt:
		as, ok := s.Init.(*ast.AssignStmt)
		if !ok || as.Tok != token.DEFINE {
			return nil, s.Body
		}
		for _, e := range as.Lhs {
			if id, ok := e.(*ast.Ident); ok && id.Name != "_" {
				names = append(names, id.Name)
			}
		}
		if assignsTo(s.Body, names) {
			return nil, s.Body
		}
		return names, s.Body
	}
	return nil, nil
}

func assignsTo(body *ast.BlockStmt, names []string) bool {
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			for _, e := range s.Lhs {
				if id, ok := e.(*ast.Ident); ok && set[id.Name] {
					found = true
				}
			}
		case *ast.IncDecStmt:
			if id, ok := s.X.(*ast.Ident); ok && set[id.Name] {
				found = true
			}
		case *ast.UnaryExpr:
			if id, ok := s.X.(*ast.Ident); ok && s.Op == token.AND && set[id.Name] {
				found = true
			}
		}
		return !found
	})
	return found
}

func noParams(t *ast.FuncType) bool {
	return (t.Params == nil || len(t.Params.List) == 0) && (t.Results == nil || len(t.Results.List) == 0)
}

func callsRecover(body *ast.BlockStmt) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if c, ok := n.(*ast.CallExpr); ok {
			if id, ok := c.Fun.(*ast.Ident); ok && id.Name == "recover" {
				found = true
			}
		}
		return !found
	})
	return found
}

// isPlainFunc reports whether id is a variable of type func() declared in the program.
func isPlainFunc(info *types.Info, id *ast.Ident) bool {
	v, ok := info.Uses[id].(*types.Var)
	if !ok || v.Pkg() == nil || v.Pkg().Path() != "main" {
		return false
	}
	sig, ok := v.Type().Underlying().(*types.Signature)
	return ok && sig.Params().Len() == 0 && sig.Results().Len() == 0
}

// Result describes one run.
type Result struct {
	Phase    string `json:"phase"` // "build" or "run"
	ExitCode int    `json:"exitCode"`
}

type panicked struct{ value any }

func (p panicked) Error() string { return fmt.Sprint(p.value) }

// Run checks, compiles and interprets a package main made of files.
// onPhase("run") is called once the program has compiled and starts running.
func Run(files map[string]string, stdout, stderr io.Writer, onPhase func(string)) Result {
	c := Check(files)
	if len(c.Blocking) > 0 {
		writeDiags(stderr, c.Blocking)
		return Result{Phase: "build", ExitCode: 1}
	}

	h := &helpers{imports: map[string]string{}, funcs: map[string]string{}}
	fsys := fstest.MapFS{}
	for _, f := range c.Files {
		name := c.Fset.Position(f.Package).Filename
		fsys["src/main/"+name] = &fstest.MapFile{Data: []byte(Rewrite(c, f, files[name], h))}
	}
	fsys["src/main/zz_microverse.go"] = &fstest.MapFile{Data: []byte(h.file())}

	started := false
	frames := &frameWriter{w: stderr}
	i := interp.New(interp.Options{GoPath: ".", SourcecodeFilesystem: slashFS{fsys}, Stdout: stdout, Stderr: frames, Args: []string{"program"}})
	rt := interp.Exports{"microverse/rt/rt": {"Started": reflect.ValueOf(func() {
		started = true
		if onPhase != nil {
			onPhase("run")
		}
	})}}
	if err := i.Use(stdlib.Symbols); err != nil {
		fmt.Fprintln(stderr, "internal error:", err)
		return Result{Phase: "build", ExitCode: 2}
	}
	if err := i.Use(rt); err != nil {
		fmt.Fprintln(stderr, "internal error:", err)
		return Result{Phase: "build", ExitCode: 2}
	}

	err := evalMain(i)
	if err == nil {
		return Result{Phase: phaseOf(started), ExitCode: 0}
	}
	var p panicked
	var ip interp.Panic
	var v any
	switch {
	case errors.As(err, &ip):
		v = ip.Value
	case errors.As(err, &p):
		v = p.value
	}
	if v != nil {
		if s, ok := v.(string); ok && strings.HasPrefix(s, "os.Exit(") {
			code, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(s, "os.Exit("), ")"))
			return Result{Phase: "run", ExitCode: code}
		}
		if !started {
			return buildFailure(stderr, c, fmt.Sprint(v))
		}
		fmt.Fprintf(stderr, "panic: %v\n\ngoroutine 1 [running]:\n", tidy(fmt.Sprint(v)))
		for _, f := range frames.frames {
			fmt.Fprintln(stderr, f)
		}
		return Result{Phase: "run", ExitCode: 2}
	}
	if !started {
		return buildFailure(stderr, c, err.Error())
	}
	fmt.Fprintln(stderr, tidy(err.Error()))
	return Result{Phase: "run", ExitCode: 1}
}

// frameWriter receives the interpreter's own messages. While a panic unwinds,
// Yaegi prints one "file:line:col: panic: fn(...)" line per frame; those are
// kept and printed under the panic message as a Go-style stack trace.
type frameWriter struct {
	w      io.Writer
	buf    []byte
	frames []string
}

var frameLine = regexp.MustCompile(`^(?:[\w./\\-]*[/\\])?src[/\\]main[/\\]([\w.-]+\.go):(\d+):(\d+): panic: (.+)\(\.\.\.\)$`)

func (f *frameWriter) Write(p []byte) (int, error) {
	f.buf = append(f.buf, p...)
	for {
		i := bytes.IndexByte(f.buf, '\n')
		if i < 0 {
			break
		}
		line := string(f.buf[:i])
		f.buf = f.buf[i+1:]
		if m := frameLine.FindStringSubmatch(line); m != nil {
			if !strings.HasPrefix(m[1], "zz_") {
				f.frames = append(f.frames, fmt.Sprintf("%s(...)\n\t./%s:%s:%s", strings.TrimSuffix(m[4], ".func"), m[1], m[2], m[3]))
			}
			continue
		}
		if _, err := io.WriteString(f.w, tidy(line)+"\n"); err != nil {
			return len(p), err
		}
	}
	return len(p), nil
}

func phaseOf(started bool) string {
	if started {
		return "run"
	}
	return "build"
}

// buildFailure reports a program the interpreter couldn't compile: in gc's
// words when the type checker found the problem, otherwise in Yaegi's.
func buildFailure(stderr io.Writer, c Checked, msg string) Result {
	if len(c.Advisory) > 0 {
		writeDiags(stderr, c.Advisory)
	} else {
		fmt.Fprintln(stderr, "# microverse/exercise")
		fmt.Fprintln(stderr, tidy(msg))
	}
	return Result{Phase: "build", ExitCode: 1}
}

// evalMain loads src/main, which compiles it and then runs its init
// functions and main. Panics escaping the program come back as errors.
func evalMain(i *interp.Interpreter) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = panicked{r}
		}
	}()
	_, err = i.EvalPath("main")
	return err
}

var (
	yaegiPath    = regexp.MustCompile(`(?:[\w./\\-]*[/\\])?src[/\\]main[/\\]([\w.-]+\.go)`)
	importPrefix = regexp.MustCompile(`(?m)^(?:\d+:\d+: )?import "main" error: `)
)

// tidy rewrites interpreter paths ("src/main/exercise.go:3:1") the way the go
// command prints them ("./exercise.go:3:1").
func tidy(s string) string {
	s = importPrefix.ReplaceAllString(s, "")
	s = yaegiPath.ReplaceAllString(s, "./$1")
	for from, to := range runtimeMessages {
		s = strings.ReplaceAll(s, from, to)
	}
	return s
}

// runtimeMessages maps the interpreter's reflect-level panics to the
// runtime errors a compiled program reports.
var runtimeMessages = map[string]string{
	"reflect: slice index out of range":                  "runtime error: index out of range",
	"reflect: array index out of range":                  "runtime error: index out of range",
	"reflect: string index out of range":                 "runtime error: index out of range",
	"reflect: call of reflect.Value.Elem on zero Value":  "runtime error: invalid memory address or nil pointer dereference",
	"reflect: call of reflect.Value.Field on zero Value": "runtime error: invalid memory address or nil pointer dereference",
}

func writeDiags(w io.Writer, diags []Diag) {
	fmt.Fprintln(w, "# microverse/exercise")
	for _, d := range diags {
		fmt.Fprintln(w, d.String())
	}
}

// Format is gofmt for one file. Errors read "line:col: message".
func Format(src string) (string, error) {
	out, err := format.Source([]byte(src))
	if err != nil {
		var list scanner.ErrorList
		if errors.As(err, &list) && len(list) > 0 {
			return "", fmt.Errorf("line:%d:%d: %s", list[0].Pos.Line, list[0].Pos.Column, list[0].Msg)
		}
		return "", err
	}
	return string(bytes.TrimRight(out, "\n")) + "\n", nil
}

// Syntax reports syntax errors for one file of any package (used by the Code
// Playground's edit mode, where the services' dependencies aren't available).
func Syntax(name, src string) []Diag {
	fset := token.NewFileSet()
	if _, err := parser.ParseFile(fset, name, src, parser.AllErrors); err != nil {
		return syntaxDiags(name, err)
	}
	return []Diag{}
}
