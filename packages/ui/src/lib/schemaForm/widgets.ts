import type { SchemaField } from "./schema";

/**
 * Which control renders a property (spec 2026-11-15 §A.4). Decided from the schema alone, so the renderer has no
 * per-form cases.
 */
export type Widget =
  "text" | "email" | "url" | "path" | "textarea" | "password" | "date" | "datetime" | "number" | "checkbox" | "segments" | "select" | "checkboxes";

/** A one-of with at most this many choices, each at most `SEGMENT_LABEL_MAX` characters, is a row of segments. */
export const SEGMENTS_MAX = 4;
export const SEGMENT_LABEL_MAX = 16;

export function widgetFor(f: SchemaField): Widget {
  const p = f.prop;
  switch (p.type) {
    case "boolean":
      // A value submitted with the form is a checkbox; a Switch applies at once (primitives/Switch: "Not for").
      return "checkbox";
    case "number":
    case "integer":
      return "number";
    case "array":
      // Spec §A.4 asks for a multi-select menu past 6 choices; v1 keeps a checkbox list for any count (no multi-select primitive yet).
      return "checkboxes";
    case "string": {
      if (f.choices) return f.choices.length <= SEGMENTS_MAX && f.choices.every((c) => Array.from(c.title).length <= SEGMENT_LABEL_MAX) ? "segments" : "select";
      if (p.format === "password") return "password";
      if (p.format === "date") return "date";
      if (p.format === "date-time") return "datetime";
      if (p.format === "email") return "email";
      if (p.format === "uri") return "url";
      if (p["x-octo"]?.widget === "path") return "path";
      if (p["x-octo"]?.multiline) return "textarea";
      return "text";
    }
  }
}
