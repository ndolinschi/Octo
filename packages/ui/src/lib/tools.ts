import { harnessTool, SPAWN_TOOL } from "./toolName";

export { harnessTool, SPAWN_TOOL };

type ToolMeta = { verb: string; arg: (input: Record<string, unknown>) => string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

const META: Record<string, ToolMeta> = {
  list_dir: { verb: "Listed", arg: (i) => str(i.path) || "." },
  read_file: { verb: "Read", arg: (i) => str(i.path) },
  write_file: { verb: "Wrote", arg: (i) => str(i.path) },
  bash: { verb: "Ran", arg: (i) => str(i.command).split("\n")[0] ?? "" },
  save_note: { verb: "Saved note", arg: (i) => str(i.title) },
  delete_note: { verb: "Deleted note", arg: (i) => str(i.title) || str(i.id) },
};

/** ACP tool kinds (the harness stores an ACP agent's tool call under its `kind`, input `{ title, raw_input?, locations? }`). */
const ACP_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other", "tool"]);

export type AcpLocation = { path: string; line?: number };

/** An ACP agent's tool call: its own title, and the files it touched. Null for built-in tools. */
export function acpCall(name: string, input: unknown): { title: string; locations: AcpLocation[] } | null {
  if (!ACP_KINDS.has(name) || typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.title !== "string") return null;
  const locations = Array.isArray(r.locations)
    ? r.locations.flatMap((l) => {
        const o = l as Record<string, unknown> | null;
        if (!o || typeof o.path !== "string") return [];
        return [typeof o.line === "number" ? { path: o.path, line: o.line } : { path: o.path }];
      })
    : [];
  return { title: r.title, locations };
}

/**
 * Past-tense verb, the main argument, and the project folder it ran in (if any). An ACP call reads as
 * its title: a leading verb ("Read README.md") takes the verb's place, so the row keeps the built-in anatomy.
 */
export function toolMeta(rawName: string, input: unknown): { verb: string; arg: string; folder: string } {
  const name = harnessTool(rawName);
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const acp = acpCall(name, input);
  if (acp) {
    const [, verb, arg] = /^(\S+)\s+(.+)$/.exec(acp.title.trim()) ?? [];
    return verb !== undefined && arg !== undefined ? { verb, arg, folder: "" } : { verb: acp.title.trim() || "Tool call", arg: "", folder: "" };
  }
  const meta = META[harnessTool(name)];
  if (!meta) {
    const first = Object.values(record).find((v) => typeof v === "string");
    return { verb: `Called ${name}`, arg: str(first), folder: "" };
  }
  return { verb: meta.verb, arg: meta.arg(record), folder: str(record.folder) };
}
