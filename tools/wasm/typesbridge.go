package main

import (
	"fmt"
	"go/constant"
	"go/token"
	"go/types"
	"path"
	"reflect"
	"strings"

	"github.com/traefik/yaegi/stdlib"
)

// bridge is a go/types importer for the standard library, built from the
// reflection data Yaegi already carries for every stdlib symbol. It gives the
// runner a real type checker (and real types for rewrites) in the browser,
// where no compiled export data exists.
//
// Reflection can't see everything (unexported interface methods of concrete
// types, generic functions), so the checker's errors are treated as advisory
// unless the interpreter fails too; see Run.
type bridge struct {
	index map[string]map[string]reflect.Value // import path → symbols
	names map[string]string                   // import path → package name
	pkgs  map[string]*types.Package
	named map[reflect.Type]*types.Named
}

func newBridge() *bridge {
	b := &bridge{index: map[string]map[string]reflect.Value{}, names: map[string]string{}, pkgs: map[string]*types.Package{}, named: map[reflect.Type]*types.Named{}}
	for key, syms := range stdlib.Symbols {
		i := strings.LastIndex(key, "/")
		if i < 0 {
			continue
		}
		b.index[key[:i]] = syms
		b.names[key[:i]] = key[i+1:]
	}
	return b
}

var errorType = reflect.TypeOf((*error)(nil)).Elem()

func (b *bridge) pkg(p string) *types.Package {
	if pkg := b.pkgs[p]; pkg != nil {
		return pkg
	}
	name := b.names[p]
	if name == "" {
		name = path.Base(p)
	}
	pkg := types.NewPackage(p, name)
	b.pkgs[p] = pkg
	return pkg
}

func isTypeSym(v reflect.Value) bool {
	return v.Kind() == reflect.Ptr && !v.CanAddr() && v.IsNil()
}

func (b *bridge) Import(p string) (*types.Package, error) {
	syms, ok := b.index[p]
	if !ok {
		return nil, fmt.Errorf("package %s is not available in the browser runner (it can use the standard library only)", p)
	}
	pkg := b.pkg(p)
	if pkg.Complete() {
		return pkg, nil
	}
	scope := pkg.Scope()
	for name, v := range syms {
		if strings.HasPrefix(name, "_") || !isTypeSym(v) {
			continue
		}
		t := v.Type().Elem()
		if t.Name() == name && t.PkgPath() == p {
			b.namedType(t)
			continue
		}
		if scope.Lookup(name) == nil { // alias, e.g. os.FileInfo = fs.FileInfo
			scope.Insert(types.NewTypeName(token.NoPos, pkg, name, b.typ(t)))
		}
	}
	for name, v := range syms {
		if strings.HasPrefix(name, "_") || isTypeSym(v) || scope.Lookup(name) != nil {
			continue
		}
		switch {
		case v.CanAddr():
			scope.Insert(types.NewVar(token.NoPos, pkg, name, b.typ(v.Type())))
		case v.Kind() == reflect.Func:
			if sig, ok := b.typ(v.Type()).(*types.Signature); ok {
				scope.Insert(types.NewFunc(token.NoPos, pkg, name, sig))
			}
		default:
			if cv, ok := v.Interface().(constant.Value); ok {
				scope.Insert(types.NewConst(token.NoPos, pkg, name, untypedFor(cv), cv))
			} else if cv := constFromValue(v); cv != nil {
				scope.Insert(types.NewConst(token.NoPos, pkg, name, b.typ(v.Type()), cv))
			}
		}
	}
	pkg.MarkComplete()
	return pkg, nil
}

func untypedFor(cv constant.Value) types.Type {
	switch cv.Kind() {
	case constant.Bool:
		return types.Typ[types.UntypedBool]
	case constant.String:
		return types.Typ[types.UntypedString]
	case constant.Float:
		return types.Typ[types.UntypedFloat]
	case constant.Complex:
		return types.Typ[types.UntypedComplex]
	}
	return types.Typ[types.UntypedInt]
}

func constFromValue(v reflect.Value) constant.Value {
	switch v.Kind() {
	case reflect.Bool:
		return constant.MakeBool(v.Bool())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return constant.MakeInt64(v.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return constant.MakeUint64(v.Uint())
	case reflect.Float32, reflect.Float64:
		return constant.MakeFloat64(v.Float())
	case reflect.String:
		return constant.MakeString(v.String())
	}
	return nil
}

var basicKinds = map[reflect.Kind]types.BasicKind{
	reflect.Bool: types.Bool, reflect.Int: types.Int, reflect.Int8: types.Int8, reflect.Int16: types.Int16,
	reflect.Int32: types.Int32, reflect.Int64: types.Int64, reflect.Uint: types.Uint, reflect.Uint8: types.Uint8,
	reflect.Uint16: types.Uint16, reflect.Uint32: types.Uint32, reflect.Uint64: types.Uint64, reflect.Uintptr: types.Uintptr,
	reflect.Float32: types.Float32, reflect.Float64: types.Float64, reflect.Complex64: types.Complex64,
	reflect.Complex128: types.Complex128, reflect.String: types.String, reflect.UnsafePointer: types.UnsafePointer,
}

func (b *bridge) typ(t reflect.Type) types.Type {
	// Named types (including instantiated generics such as the stdlib's
	// internal HashTrieMap[K, V]) go through namedType, whose cache also
	// stops recursion through self-referencing types.
	if t.Name() != "" {
		if t.PkgPath() == "" {
			if t == errorType {
				return types.Universe.Lookup("error").Type()
			}
			if k, ok := basicKinds[t.Kind()]; ok {
				return types.Typ[k]
			}
		} else {
			return b.namedType(t)
		}
	}
	return b.structure(t)
}

func (b *bridge) namedType(t reflect.Type) *types.Named {
	if n := b.named[t]; n != nil {
		return n
	}
	pkg := b.pkg(t.PkgPath())
	obj := types.NewTypeName(token.NoPos, pkg, t.Name(), nil)
	n := types.NewNamed(obj, nil, nil)
	b.named[t] = n
	if pkg.Scope().Lookup(t.Name()) == nil {
		pkg.Scope().Insert(obj)
	}
	n.SetUnderlying(b.structure(t))
	if t.Kind() != reflect.Interface {
		for i := 0; i < t.NumMethod(); i++ {
			m := t.Method(i)
			n.AddMethod(types.NewFunc(token.NoPos, pkg, m.Name, b.signature(m.Type, types.NewVar(token.NoPos, pkg, "", n))))
		}
		pt := reflect.PointerTo(t)
		for i := 0; i < pt.NumMethod(); i++ {
			m := pt.Method(i)
			if _, ok := t.MethodByName(m.Name); ok {
				continue
			}
			n.AddMethod(types.NewFunc(token.NoPos, pkg, m.Name, b.signature(m.Type, types.NewVar(token.NoPos, pkg, "", types.NewPointer(n)))))
		}
	}
	return n
}

// signature converts a func type; with recv set, the first parameter (the
// receiver, as reflect reports methods) is dropped.
func (b *bridge) signature(t reflect.Type, recv *types.Var) *types.Signature {
	var params, results []*types.Var
	start := 0
	if recv != nil {
		start = 1
	}
	for i := start; i < t.NumIn(); i++ {
		params = append(params, types.NewVar(token.NoPos, nil, "", b.typ(t.In(i))))
	}
	for i := 0; i < t.NumOut(); i++ {
		results = append(results, types.NewVar(token.NoPos, nil, "", b.typ(t.Out(i))))
	}
	return types.NewSignatureType(recv, nil, nil, types.NewTuple(params...), types.NewTuple(results...), t.IsVariadic())
}

func (b *bridge) structure(t reflect.Type) types.Type {
	switch t.Kind() {
	case reflect.Ptr:
		return types.NewPointer(b.typ(t.Elem()))
	case reflect.Slice:
		return types.NewSlice(b.typ(t.Elem()))
	case reflect.Array:
		return types.NewArray(b.typ(t.Elem()), int64(t.Len()))
	case reflect.Map:
		return types.NewMap(b.typ(t.Key()), b.typ(t.Elem()))
	case reflect.Chan:
		dir := types.SendRecv
		switch t.ChanDir() {
		case reflect.SendDir:
			dir = types.SendOnly
		case reflect.RecvDir:
			dir = types.RecvOnly
		}
		return types.NewChan(dir, b.typ(t.Elem()))
	case reflect.Func:
		return b.signature(t, nil)
	case reflect.Interface:
		var methods []*types.Func
		for i := 0; i < t.NumMethod(); i++ {
			m := t.Method(i)
			var pkg *types.Package
			if m.PkgPath != "" {
				pkg = b.pkg(m.PkgPath)
			} else if t.PkgPath() != "" {
				pkg = b.pkg(t.PkgPath())
			}
			methods = append(methods, types.NewFunc(token.NoPos, pkg, m.Name, b.signature(m.Type, nil)))
		}
		return types.NewInterfaceType(methods, nil).Complete()
	case reflect.Struct:
		var fields []*types.Var
		var tags []string
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			var pkg *types.Package
			if f.PkgPath != "" {
				pkg = b.pkg(f.PkgPath)
			} else if t.PkgPath() != "" {
				pkg = b.pkg(t.PkgPath())
			}
			fields = append(fields, types.NewField(token.NoPos, pkg, f.Name, b.typ(f.Type), f.Anonymous))
			tags = append(tags, string(f.Tag))
		}
		return types.NewStruct(fields, tags)
	}
	if k, ok := basicKinds[t.Kind()]; ok {
		return types.Typ[k]
	}
	return types.Typ[types.Invalid]
}
