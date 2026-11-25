/**
 * Browser URL normalization, Design Mode annotation types, and the `octo-design` wire block
 * appended to orchestrator messages (and split back out for rendering in `Transcript`).
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type ComponentInfo = {
  name: string;
  stack: string[];
  file?: string | undefined;
  line?: number | undefined;
};

export type ComputedStyleSummary = {
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontFamily: string;
  display: string;
  position: string;
};

export type PickedElement = {
  selector: string;
  tag: string;
  id: string;
  classes: string[];
  attributes: Record<string, string>;
  text: string;
  rect: Rect;
  pageRect?: Rect | undefined;
  styles: ComputedStyleSummary;
  editableStyles?: Record<string, string> | undefined;
  component?: ComponentInfo | undefined;
};

export type CssEdit = {
  selector: string;
  property: string;
  before: string;
  after: string;
};

export type TextEdit = {
  selector: string;
  before: string;
  after: string;
};

export type MarkupPoint = { x: number; y: number };

export type MarkupStroke =
  | { kind: "draw"; points: MarkupPoint[]; color?: string | undefined; width?: number | undefined }
  | {
      kind: "rect" | "ellipse" | "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color?: string | undefined;
      width?: number | undefined;
    };

export type DesignNote = {
  id: string;
  url: string;
  elements: PickedElement[];
  area?: Rect | undefined;
  strokes?: MarkupStroke[] | undefined;
  cssEdits?: CssEdit[] | undefined;
  textEdit?: TextEdit | undefined;
  text: string;
  pngBytes?: Uint8Array | undefined;
  pinNumber?: number | undefined;
  created: number;
};

export type SentDesignNote = {
  url: string;
  elements: PickedElement[];
  area?: Rect | undefined;
  cssEdits: CssEdit[];
  textEdit?: TextEdit | undefined;
  markupCount?: number | undefined;
  text: string;
  hasScreenshot?: boolean | undefined;
};

const LANG = "octo-design";
const BLOCK = /(^|\n)(`{3,})octo-design[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/|$)/i;

/** Normalizes user-entered URLs (`localhost:3000` -> `http://localhost:3000/`, `cursor.com` -> `https://cursor.com/`). */
export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (/^:\d+(\/|$)/.test(candidate)) {
    candidate = `http://localhost${candidate}`;
  } else if (LOCAL_HOST.test(candidate) || /^[a-zA-Z0-9.-]+:\d+(\/|$)/.test(candidate)) {
    candidate = `http://${candidate}`;
  } else if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)) {
    if (candidate.includes(".")) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    if (u.hostname === "0.0.0.0") u.hostname = "localhost";
    return u.toString();
  } catch {
    return null;
  }
}

/** Short host[:port] label for Browser tabs and summaries. */
export function browserHostLabel(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.host || rawUrl;
  } catch {
    return rawUrl.trim() || "Browser";
  }
}

/** Short selector/component label for chips and cards (`<HeroCard> button.cta` or `button#save`). */
export function elementSummary(el: PickedElement): string {
  const comp = el.component?.name ? `<${el.component.name}> ` : "";
  const id = el.id ? `#${el.id}` : "";
  const cls = !id && el.classes[0] ? `.${el.classes[0]}` : "";
  return `${comp}${el.tag}${id}${cls}`;
}

function wireElement(el: PickedElement) {
  return {
    selector: el.selector,
    tag: el.tag,
    ...(el.id ? { id: el.id } : {}),
    ...(el.classes.length ? { classes: el.classes } : {}),
    ...(Object.keys(el.attributes).length ? { attributes: el.attributes } : {}),
    ...(el.text ? { text: el.text } : {}),
    rect: el.rect,
    styles: el.styles,
    ...(el.component ? { component: el.component } : {}),
  };
}

/** Formats `notes` into a fenced `octo-design` JSON-lines block with full DOM, CSS, component, and edit context. */
export function formatDesignNotes(notes: readonly DesignNote[]): string {
  const lines = notes.map((n) => {
    const entry: Record<string, unknown> = {
      url: n.url,
      elements: n.elements.map(wireElement),
      ...(n.area ? { area: n.area } : {}),
      ...(n.cssEdits?.length ? { cssEdits: n.cssEdits } : {}),
      ...(n.textEdit ? { textEdit: n.textEdit } : {}),
      ...(n.strokes?.length ? { markupCount: n.strokes.length } : {}),
      text: n.text.trim(),
      ...(n.pngBytes ? { hasScreenshot: true } : {}),
    };
    return JSON.stringify(entry);
  });
  const body = lines.join("\n");
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${LANG}\n${body}\n${fence}`;
}

/** Appends a formatted `octo-design` block to `prose` (or returns `block` alone when `prose` is empty). */
export function withDesignNotes(prose: string, block: string): string {
  const clean = prose.trim();
  return clean ? `${clean}\n\n${block}` : block;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRect(v: unknown): Rect | undefined {
  if (!isRecord(v)) return undefined;
  const { x, y, width, height } = v;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return undefined;
  return { x, y, width, height };
}

function parseComponent(v: unknown): ComponentInfo | undefined {
  if (!isRecord(v) || typeof v.name !== "string" || !v.name) return undefined;
  const stack = Array.isArray(v.stack) ? v.stack.filter((s): s is string => typeof s === "string") : [v.name];
  return {
    name: v.name,
    stack,
    ...(typeof v.file === "string" && v.file ? { file: v.file } : {}),
    ...(typeof v.line === "number" ? { line: v.line } : {}),
  };
}

function parsePickedElement(v: unknown): PickedElement | null {
  if (!isRecord(v) || typeof v.selector !== "string" || typeof v.tag !== "string") return null;
  const rect = parseRect(v.rect) ?? { x: 0, y: 0, width: 0, height: 0 };
  const rawStyles = isRecord(v.styles) ? v.styles : {};
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const attributes: Record<string, string> = {};
  if (isRecord(v.attributes)) {
    for (const [k, val] of Object.entries(v.attributes)) {
      if (typeof val === "string") attributes[k] = val;
    }
  }
  const classes = Array.isArray(v.classes) ? v.classes.filter((c): c is string => typeof c === "string") : [];
  const component = parseComponent(v.component);
  return {
    selector: v.selector,
    tag: v.tag,
    id: str(v.id),
    classes,
    attributes,
    text: str(v.text),
    rect,
    styles: {
      color: str(rawStyles.color),
      backgroundColor: str(rawStyles.backgroundColor),
      fontSize: str(rawStyles.fontSize),
      fontFamily: str(rawStyles.fontFamily),
      display: str(rawStyles.display),
      position: str(rawStyles.position),
    },
    ...(component ? { component } : {}),
  };
}

function parseCssEdit(v: unknown): CssEdit | null {
  if (!isRecord(v)) return null;
  const { selector, property, before, after } = v;
  if (typeof selector !== "string" || typeof property !== "string" || typeof before !== "string" || typeof after !== "string") return null;
  return { selector, property, before, after };
}

function parseTextEdit(v: unknown): TextEdit | undefined {
  if (!isRecord(v)) return undefined;
  const { selector, before, after } = v;
  if (typeof selector !== "string" || typeof before !== "string" || typeof after !== "string") return undefined;
  return { selector, before, after };
}

function parseSentLine(line: string): SentDesignNote | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw: unknown = JSON.parse(trimmed);
    if (!isRecord(raw) || typeof raw.url !== "string") return null;
    const elements = Array.isArray(raw.elements)
      ? raw.elements.flatMap((e) => {
          const p = parsePickedElement(e);
          return p ? [p] : [];
        })
      : [];
    const cssEdits = Array.isArray(raw.cssEdits)
      ? raw.cssEdits.flatMap((c) => {
          const p = parseCssEdit(c);
          return p ? [p] : [];
        })
      : [];
    const area = parseRect(raw.area);
    const textEdit = parseTextEdit(raw.textEdit);
    return {
      url: raw.url,
      elements,
      ...(area ? { area } : {}),
      cssEdits,
      ...(textEdit ? { textEdit } : {}),
      ...(typeof raw.markupCount === "number" && raw.markupCount > 0 ? { markupCount: raw.markupCount } : {}),
      text: typeof raw.text === "string" ? raw.text : "",
      ...(raw.hasScreenshot === true ? { hasScreenshot: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Splits a user message into its prose and any structured `octo-design` notes. */
export function splitDesignNotes(text: string): { prose: string; notes: SentDesignNote[] } {
  if (!text.includes(LANG)) return { prose: text, notes: [] };
  const notes: SentDesignNote[] = [];
  const prose = text
    .replace(BLOCK, (_m, lead: string, _fence: string, body: string) => {
      for (const line of body.split("\n")) {
        const parsed = parseSentLine(line);
        if (parsed) notes.push(parsed);
      }
      return lead;
    })
    .trim();
  return { prose, notes };
}

/** Summary string for titles and pills ("2 design notes on localhost:5173"). */
export function designNotesSummary(notes: readonly { url: string }[]): string {
  const n = notes.length;
  const first = browserHostLabel(notes[0]?.url ?? "");
  return `${n}\u00a0design ${n === 1 ? "note" : "notes"}${first ? ` on ${first}` : ""}`;
}

/** Uploads PNG screenshots (if supported) and formats staged Design Mode notes into an `octo-design` wire block. */
export async function prepareDesignNotes(
  notes: readonly DesignNote[],
  uploadAttachment?: (data: Uint8Array, opts?: { name?: string }) => Promise<{ id: string }>,
): Promise<{ block: string; attachments: string[]; sentIds: Set<string> }> {
  const attachments: string[] = [];
  if (uploadAttachment) {
    for (const [idx, note] of notes.entries()) {
      if (!note.pngBytes) continue;
      try {
        const uploaded = await uploadAttachment(note.pngBytes, { name: `design-note-${idx + 1}.png` });
        attachments.push(uploaded.id);
      } catch {
        // Sending DOM + CSS + note text still succeeds when image attachment upload is unsupported or fails.
      }
    }
  }
  return { block: formatDesignNotes(notes), attachments, sentIds: new Set(notes.map((n) => n.id)) };
}
