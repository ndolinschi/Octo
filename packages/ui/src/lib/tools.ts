export const SPAWN_TOOL = "spawn_agent";

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
export function toolMeta(name: string, input: unknown): { verb: string; arg: string; folder: string } {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const acp = acpCall(name, input);
  if (acp) {
    const [, verb, arg] = /^(\S+)\s+(.+)$/.exec(acp.title.trim()) ?? [];
    return verb !== undefined && arg !== undefined ? { verb, arg, folder: "" } : { verb: acp.title.trim() || "Tool call", arg: "", folder: "" };
  }
  const meta = META[name];
  if (!meta) {
    const first = Object.values(record).find((v) => typeof v === "string");
    return { verb: `Called ${name}`, arg: str(first), folder: "" };
  }
  return { verb: meta.verb, arg: meta.arg(record), folder: str(record.folder) };
}

/** The project folder (label) and folder-relative path for an absolute or relative path an ACP agent reported. */
export function locateInProject(folders: { label: string; path: string }[], raw: string): { folder: string; path: string } | null {
  const p = raw.replace(/\\/g, "/");
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) return folders[0] ? { folder: folders[0].label, path: p.replace(/^\.\//, "") } : null;
  let best: { folder: string; path: string; len: number } | null = null;
  for (const f of folders) {
    const root = f.path.replace(/\\/g, "/").replace(/\/$/, "");
    if ((p === root || p.startsWith(`${root}/`)) && (!best || root.length > best.len))
      best = { folder: f.label, path: p.slice(root.length + 1), len: root.length };
  }
  return best && best.path ? { folder: best.folder, path: best.path } : null;
}

export type WrittenFile = { folder: string; path: string; at: string; agentId: string };

/**
 * Files an agent wrote, from its stored transcript: `write_file` calls and ACP `edit` calls (their
 * locations) whose result was not an error. `at` is the time of the call's message.
 */
export function writtenFiles(
  messages: { agent_id: string; role: string; created_at: string; content: { type: string; [k: string]: unknown }[] }[],
  folders: { label: string; path: string }[],
): WrittenFile[] {
  const failed = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_result" && b.is_error) failed.add(String(b.tool_use_id));
  const out: WrittenFile[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use" || failed.has(String(b.id))) continue;
      const name = String(b.name);
      if (name === "write_file") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const folder = typeof input.folder === "string" && input.folder ? input.folder : folders[0]?.label;
        const path = typeof input.path === "string" ? input.path.replace(/^\.\//, "") : "";
        if (folder && path && folders.some((f) => f.label === folder)) out.push({ folder, path, at: m.created_at, agentId: m.agent_id });
        continue;
      }
      const acp = acpCall(name, b.input);
      if (!acp || name !== "edit") continue;
      for (const l of acp.locations) {
        const hit = locateInProject(folders, l.path);
        if (hit) out.push({ ...hit, at: m.created_at, agentId: m.agent_id });
      }
    }
  }
  return out;
}

/** The file or folder path a built-in tool call operates on, if it has one (ACP calls: see `acpCall`). */
export function toolPath(name: string, input: unknown): string {
  if (name !== "read_file" && name !== "write_file" && name !== "list_dir") return "";
  return typeof input === "object" && input !== null ? str((input as Record<string, unknown>).path) : "";
}

export type SpawnInput = { role: string; title: string; task: string; tier: string };

export function spawnInput(input: unknown): SpawnInput {
  const r = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return { role: str(r.role), title: str(r.title), task: str(r.task), tier: str(r.tier) };
}
