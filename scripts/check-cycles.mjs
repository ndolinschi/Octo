#!/usr/bin/env node
// Fails when the relative-import graph of the frontend packages has a cycle (type-only imports, re-exports and
// `import()` count). Walks every .ts/.tsx under packages/ui/src, apps/desktop/src, and apps/web/src with
// the TypeScript parser. Usage: node scripts/check-cycles.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(root, "packages/ui/package.json"))("typescript");
// agent-client is out of scope for Q4: it has one known value cycle (lspSession.ts <-> client.ts via BridgeError), reported separately.
const DIRS = ["packages/ui/src", "apps/desktop/src", "apps/web/src"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function resolveSpec(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function importsOf(file) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specs.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return specs.filter((s) => s.startsWith(".")).map((s) => resolveSpec(file, s)).filter(Boolean);
}

const files = DIRS.flatMap((d) => walk(path.join(root, d)));
const graph = new Map(files.map((f) => [f, importsOf(f)]));

// Tarjan's strongly connected components; a component of two or more files (or a self-import) is a cycle.
let counter = 0;
const index = new Map();
const low = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];
function connect(v) {
  index.set(v, counter);
  low.set(v, counter++);
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!index.has(w)) {
      connect(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) cycles.push(comp);
  }
}
for (const f of files) if (!index.has(f)) connect(f);

const edges = [...graph.values()].reduce((n, l) => n + l.length, 0);
if (cycles.length > 0) {
  console.error(`Import cycles (${cycles.length}):`);
  for (const c of cycles) console.error("  " + c.map((f) => path.relative(root, f)).join(" -> "));
  process.exit(1);
}
console.log(`check-cycles: ${files.length} files, ${edges} relative imports, no cycles`);
