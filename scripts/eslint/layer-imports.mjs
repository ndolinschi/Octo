// ESLint rule `octo/layer-imports`: the "Allowed imports" table of packages/ui/ARCHITECTURE.md, enforced on resolved
// paths (a specifier like `../chat/Markdown` is classified by where it points, not by how it is spelled).
//
//   lib → –                      lsp → lib
//   state → lib, lsp
//   primitives → lib             shared → lib, state, primitives
//   <feature> → lib, lsp, state, primitives, shared, itself
//   dock → lib, state, primitives, shared, features             app → lib, state, primitives, shared, dock, features
//   demo → lib, lsp              index.ts (package root files) → app, state
//
// Value imports, `import type`, re-exports, `import()` and `typeof import()` types all count: there are no exceptions.
import path from "node:path";

const SPECIAL_COMPONENT_DIRS = new Set(["primitives", "shared", "dock"]);
const FEATURE = "feature:";

/** @type {Record<string, string[]>} */
const TABLE = {
  lib: [],
  lsp: ["lib"],
  state: ["lib", "lsp"],
  primitives: ["lib"],
  shared: ["lib", "state", "primitives"],
  dock: ["lib", "state", "primitives", "shared", "features"],
  app: ["lib", "state", "primitives", "shared", "dock", "features"],
  demo: ["lib", "lsp"],
  root: ["app", "state"],
};
const FEATURE_MAY = ["lib", "lsp", "state", "primitives", "shared"];

/** Layer of a path relative to packages/ui/src. */
export function layerOf(rel) {
  const parts = rel.split(path.sep);
  if (parts.length === 1) return "root";
  const [top, second] = parts;
  if (top === "components") {
    if (parts.length === 2) return "components";
    return SPECIAL_COMPONENT_DIRS.has(second) ? second : `${FEATURE}${second}`;
  }
  return top;
}

export function allows(from, to) {
  if (from === to) return true;
  if (from.startsWith(FEATURE)) return FEATURE_MAY.includes(to);
  const list = TABLE[from];
  if (!list) return false;
  return list.includes(to) || (list.includes("features") && to.startsWith(FEATURE));
}

const describe = (layer) => (layer.startsWith(FEATURE) ? `feature ${layer.slice(FEATURE.length)}` : layer);

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    schema: [{ type: "object", properties: { root: { type: "string" } }, required: ["root"], additionalProperties: false }],
    messages: {
      forbidden:
        "{{from}} may not import {{to}} ('{{spec}}'). Layers: see 'Allowed imports' in packages/ui/ARCHITECTURE.md; move the shared code down, never add an exception.",
    },
  },
  create(context) {
    const root = path.resolve(/** @type {{ root: string }} */ (context.options[0]).root);
    const file = context.filename;
    const fromRel = path.relative(root, file);
    if (fromRel.startsWith("..")) return {};
    const from = layerOf(fromRel);

    /** @param {import("estree").Node} node @param {unknown} source */
    const check = (node, source) => {
      if (typeof source !== "string" || !source.startsWith(".")) return;
      const target = path.resolve(path.dirname(file), source);
      const toRel = path.relative(root, target);
      if (toRel.startsWith("..")) return;
      const to = layerOf(toRel);
      if (allows(from, to)) return;
      context.report({ node, messageId: "forbidden", data: { from: describe(from), to: describe(to), spec: source } });
    };

    return {
      ImportDeclaration: (n) => check(n, n.source.value),
      ExportAllDeclaration: (n) => check(n, n.source.value),
      ExportNamedDeclaration: (n) => {
        if (n.source) check(n, n.source.value);
      },
      ImportExpression: (n) => {
        if (n.source.type === "Literal") check(n, n.source.value);
      },
      // `typeof import("./x")` types (typescript-estree)
      TSImportType: (n) => {
        const arg = /** @type {any} */ (n).argument ?? /** @type {any} */ (n).parameter;
        const lit = arg?.type === "TSLiteralType" ? arg.literal : arg;
        if (lit?.type === "Literal") check(n, lit.value);
      },
    };
  },
};
