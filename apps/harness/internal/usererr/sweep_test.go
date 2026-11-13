package usererr

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The sweep keeps new ad-hoc user-visible strings out of the packages that
// build errors for the UI. It parses their non-test files and collects the
// first string literal handed to a helper that makes a route error
// (writeError, invalid, conflict, notFound, fileTooLarge, ...) or set as the
// Message of an &Error{...} literal. The collected set must equal
// testdata/adhoc_strings.txt exactly:
//
//   - A new entry fails the test: say it with a catalogue constructor in
//     internal/usererr (and use it), or, when the sentence is technical text
//     for the client's developer that the bridge turns into `details` (the
//     catalogue's generic wording is what a person reads), add the line to
//     the file with `UPDATE_ADHOC=1 go test ./internal/usererr -run NoAdHoc`
//     and say why in the review.
//   - A line that no longer matches anything fails too, so the list shrinks
//     as strings move into the catalogue.
var sweepHelpers = map[string]bool{
	"writeError": true, "invalid": true, "conflict": true, "notFound": true, "fileTooLarge": true,
}

var sweepPackages = []string{"bridge", "project", "review", "commands", "settings"}

func TestNoAdHocStrings(t *testing.T) {
	got := map[string]bool{}
	for _, pkg := range sweepPackages {
		dir := filepath.Join("..", pkg)
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			fset := token.NewFileSet()
			af, err := parser.ParseFile(fset, f, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			base := pkg + "/" + filepath.Base(f)
			ast.Inspect(af, func(n ast.Node) bool {
				switch x := n.(type) {
				case *ast.CallExpr:
					if id, ok := x.Fun.(*ast.Ident); ok && sweepHelpers[id.Name] {
						if lit := firstLiteral(x.Args); lit != "" {
							got[base+"|"+id.Name+"|"+lit] = true
						}
					}
				case *ast.CompositeLit:
					if tn := typeName(x.Type); tn != "Error" {
						return true
					}
					for _, el := range x.Elts {
						kv, ok := el.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						if k, ok := kv.Key.(*ast.Ident); ok && k.Name == "Message" {
							if lit := firstLiteral([]ast.Expr{kv.Value}); lit != "" {
								got[base+"|Error.Message|"+lit] = true
							}
						}
					}
				}
				return true
			})
		}
	}
	var lines []string
	for k := range got {
		lines = append(lines, k)
	}
	sort.Strings(lines)
	golden := filepath.Join("testdata", "adhoc_strings.txt")
	if os.Getenv("UPDATE_ADHOC") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, l := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		want[l] = true
	}
	for _, l := range lines {
		if !want[l] {
			t.Errorf("new ad-hoc user-visible string: %s\n\tuse a constructor of internal/usererr (see apps/harness/docs/errors.md)", l)
		}
	}
	for l := range want {
		if !got[l] {
			t.Errorf("stale allow-list line (the string is gone; remove it): %s", l)
		}
	}
}

func typeName(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return x.Sel.Name
	}
	return ""
}

// firstLiteral is the first string literal found in args, looking through
// fmt.Sprintf calls and + concatenations ("" when there is none).
func firstLiteral(args []ast.Expr) string {
	for _, a := range args {
		switch x := a.(type) {
		case *ast.BasicLit:
			if x.Kind == token.STRING {
				s, err := strconv.Unquote(x.Value)
				if err == nil {
					return s
				}
			}
		case *ast.BinaryExpr:
			if s := firstLiteral([]ast.Expr{x.X}); s != "" {
				return s
			}
		case *ast.CallExpr:
			if s := firstLiteral(x.Args); s != "" {
				return s
			}
		}
	}
	return ""
}
