import { acpCall } from "./tools";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What the tool details, delegation cards and written-files list need beyond the live line; kept out of `tools.ts` so the first paint does not carry it. */

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
  return best?.path ? { folder: best.folder, path: best.path } : null;
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

/** Whether a tool's text is a unified diff (header or hunk lines, and +/- lines): it is then shown with diff colours. */
export function looksLikeDiff(text: string): boolean {
  const lines = text.split("\n", 400);
  const hunk = lines.some((l) => l.startsWith("@@ ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("diff --git"));
  const changes = lines.filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
  return hunk && changes > 0;
}

/** ACP tool kinds and built-in tools that run commands: what they change on disk is not tracked as a written file. */
const COMMAND_TOOLS = new Set(["bash", "execute"]);

/** When an agent ran a command (built-in `bash` or an ACP `execute` call), from its stored transcript. */
export function commandRuns(messages: readonly { role: string; created_at: string; content: readonly { type: string; [k: string]: unknown }[] }[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_use" && COMMAND_TOOLS.has(String(b.name))) out.push(m.created_at);
  }
  return out;
}
