// ESLint rule `octo/no-native-controls`: a feature composes the primitives in `components/primitives`; it never styles
// a native control. Reports `<button>`, `<input>`, `<select>`, `<textarea>` and `<dialog>` in JSX outside the allowed
// folder (decision 90, docs/superpowers/research/2026-11-12-ui-component-audit.md).
//
// Severity is `warn` while the code base still has copies; the count is recorded in the audit as a baseline and may only
// go down. Fix a warning by using (or extending) a primitive, never by disabling the rule.
import path from "node:path";

export const NATIVE_CONTROLS = new Set(["button", "input", "select", "textarea", "dialog"]);

/** What to use instead of each native element (named in the message, so the fix is one search away). */
export const INSTEAD = {
  button: "Button, IconButton, Chip or a primitive row",
  input: "Input, Checkbox or the search Field",
  select: "Select",
  textarea: "Textarea",
  dialog: "Dialog",
};

/**
 * True when `file` (absolute) is inside one of the `allow` folders (relative to `root`).
 * @param {string} root @param {string} file @param {readonly string[]} allow
 */
export function isAllowed(root, file, allow) {
  const rel = path.relative(path.resolve(root), file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true; // not ours
  const parts = rel.split(path.sep).join("/");
  return allow.some((dir) => parts === dir || parts.startsWith(`${dir}/`));
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    schema: [
      {
        type: "object",
        properties: { root: { type: "string" }, allow: { type: "array", items: { type: "string" } } },
        required: ["root"],
        additionalProperties: false,
      },
    ],
    messages: {
      native:
        "Native <{{tag}}> outside components/primitives. Use {{instead}}; if the look you need is missing, add a variant to the primitive (decision 90) instead of styling the native element here.",
    },
  },
  create(context) {
    const options = /** @type {{ root: string; allow?: string[] }} */ (context.options[0]);
    const allow = options.allow ?? ["components/primitives"];
    if (isAllowed(options.root, context.filename, allow)) return {};
    return {
      JSXOpeningElement(node) {
        const name = node.name;
        if (name.type !== "JSXIdentifier" || !NATIVE_CONTROLS.has(name.name)) return;
        context.report({
          node,
          messageId: "native",
          data: { tag: name.name, instead: INSTEAD[/** @type {keyof typeof INSTEAD} */ (name.name)] },
        });
      },
    };
  },
};
