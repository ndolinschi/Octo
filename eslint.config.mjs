// Flat config for the frontend: packages/ui, packages/agent-client, apps/desktop.
//
// Severity policy: a rule is an error when the code already meets it. A rule the code cannot meet yet is a
// warning, listed under its debt row in packages/ui/ARCHITECTURE.md; the warning count is the baseline that steps
// Q3-Q5 of docs/superpowers/plans/2026-11-10-frontend-code-quality.md drive to zero.
//
// Import boundaries encode the "Allowed imports" table in packages/ui/ARCHITECTURE.md: the `octo/layer-imports` rule
// (scripts/eslint/layer-imports.mjs) classifies every relative import by the layer it resolves to. There are no
// exceptions and no warnings; scripts/check-cycles.mjs forbids import cycles.
import path from "node:path";
import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import layerImports from "./scripts/eslint/layer-imports.mjs";
import noNativeControls from "./scripts/eslint/no-native-controls.mjs";

const UI = "packages/ui/src";

// ---- Third-party import bans ----

const NO_TAURI = { group: ["@tauri-apps/*"], message: "Hosts pass HostCapabilities; packages/ui never imports Tauri." };
const MONACO_MSG = "Value imports of monaco-editor live only in components/files/monaco.ts (loaded with import()). Use `import type`.";
const MONACO_PATH = { name: "monaco-editor", allowTypeImports: true, message: MONACO_MSG };
const MONACO_DEEP = { group: ["monaco-editor/*"], allowTypeImports: true, message: MONACO_MSG };
const NUL_MESSAGE = "The NUL separator belongs to lib/files.ts: build keys with fileKey(), read them with splitKey() / parseFileKey() / keyFolder() / keyInFolder() / isRootKey().";
const AGENT_CLIENT = {
  paths: ["react", "react-dom", "@octo/ui"].map((name) => ({ name, message: "agent-client has no React, DOM or UI dependency." })),
  patterns: [{ group: ["react/*", "react-dom/*", "@octo/ui/*", "@tauri-apps/*"], message: "agent-client is platform-free." }],
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "apps/harness/**",
      "apps/router/**",
      "apps/desktop/src-tauri/**",
      "apps/desktop/vite.config.ts",
      "**/*.{js,mjs,cjs}",
    ],
  },

  // ---- Language rules ----
  {
    files: ["packages/*/src/**/*.{ts,tsx}", "apps/desktop/src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Rules from the brief: errors.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
      "no-empty": ["error", { allowEmptyCatch: false }],

      // Warnings: the code cannot meet these yet (counted in the Q1 report; Q3-Q5 remove them).
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn", // defensive checks the types already rule out
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": ["warn", { ignorePrimitives: { string: true, number: true, boolean: true } }],
      "@typescript-eslint/no-deprecated": "warn", // FormEvent, lucide absoluteStrokeWidth, BeforeUnloadEvent.returnValue
      "@typescript-eslint/no-dynamic-delete": "warn",

      // Tuned for this code base, not debt: a rule is off only where it flags an established convention.
      "@typescript-eslint/consistent-type-definitions": "off", // `type` aliases throughout, no interfaces
      "@typescript-eslint/no-confusing-void-expression": "off", // `() => setX(v)` shorthand is the house style
      "@typescript-eslint/unbound-method": "off", // method-signature types (`run(): void`) are passed around as callbacks
      "@typescript-eslint/require-await": "off", // async adapters that implement a Promise-returning interface
      "@typescript-eslint/non-nullable-type-assertion-style": "off", // contradicts no-non-null-assertion
      "@typescript-eslint/no-meaningless-void-operator": "off", // `void el.offsetHeight` forces a reflow on purpose
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions", "methods"] }], // deliberate no-ops (`dispose() {}`)
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }], // async React handlers
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-irregular-whitespace": ["error", { skipTemplates: true, skipJSXText: true, skipRegExps: true }], // deliberate NBSP
    },
  },

  // ---- React and accessibility (UI and the host) ----
  {
    files: [`${UI}/**/*.{ts,tsx}`, "apps/desktop/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Warnings (debt, Q5): the React Compiler rules of react-hooks 7 and the a11y findings that need markup changes.
      ...Object.fromEntries(
        [
          "react-hooks/set-state-in-effect",
          "react-hooks/refs",
          "react-hooks/purity",
          "react-hooks/immutability",
          "react-hooks/preserve-manual-memoization",
          "jsx-a11y/click-events-have-key-events",
          "jsx-a11y/interactive-supports-focus",
          "jsx-a11y/no-autofocus",
          "jsx-a11y/no-noninteractive-element-interactions",
          "jsx-a11y/no-noninteractive-tabindex",
          "jsx-a11y/no-static-element-interactions",
          "jsx-a11y/role-supports-aria-props",
        ].map((rule) => [rule, "warn"]),
      ),
    },
  },
  { files: ["packages/agent-client/src/**/*.ts"], languageOptions: { globals: globals.node } },

  // ---- Import boundaries: errors ----
  {
    files: [`${UI}/**/*.{ts,tsx}`],
    ignores: [`${UI}/components/files/monaco.ts`],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [MONACO_PATH], patterns: [MONACO_DEEP, NO_TAURI] }],
    },
  },
  {
    files: [`${UI}/components/files/monaco.ts`],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [NO_TAURI] }] },
  },
  {
    files: [`${UI}/lib/**`],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [MONACO_PATH], patterns: [MONACO_DEEP, NO_TAURI] }],
    },
  },
  {
    files: ["packages/agent-client/src/**/*.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", AGENT_CLIENT] },
  },

  // ---- Layer imports: the "Allowed imports" table of ARCHITECTURE.md on resolved paths; errors, no exceptions ----
  {
    files: [`${UI}/**/*.{ts,tsx}`],
    plugins: { octo: { rules: { "layer-imports": layerImports, "no-native-controls": noNativeControls } } },
    // Absolute: `pnpm lint` runs from a package directory, where the relative `UI` would resolve to packages/ui/packages/ui/src
    // and every file would look "outside" the root (the rule then returned early and was silently off).
    rules: { "octo/layer-imports": ["error", { root: path.join(import.meta.dirname, UI) }] },
  },

  // ---- Components: a feature composes primitives and never styles a native control (decision 90) ----
  // A warning while copies remain; the baseline count is in docs/superpowers/research/2026-11-12-ui-component-audit.md
  // and may only go down. The rule itself skips components/primitives.
  {
    files: [`${UI}/**/*.tsx`],
    rules: { "octo/no-native-controls": ["warn", { root: path.join(import.meta.dirname, UI) }] },
  },

  // ---- Ids: the NUL separator of file keys (and so of file tab ids) is private to lib/files.ts ----
  {
    files: [`${UI}/**/*.{ts,tsx}`],
    ignores: [`${UI}/lib/files.ts`],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "Literal[raw=/\\\\(u0000|x00)/]", message: NUL_MESSAGE },
        { selector: "TemplateElement[value.raw=/\\\\(u0000|x00)/]", message: NUL_MESSAGE },
      ],
    },
  },

  // ---- Tests: doubles may throw non-Errors ----
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/only-throw-error": "off",
    },
  },
);
