export const SPAWN_TOOL = "spawn_agent";

type ToolMeta = { verb: string; arg: (input: Record<string, unknown>) => string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

const META: Record<string, ToolMeta> = {
  list_dir: { verb: "List", arg: (i) => str(i.path) || "." },
  read_file: { verb: "Read", arg: (i) => str(i.path) },
  write_file: { verb: "Write", arg: (i) => str(i.path) },
  bash: { verb: "Run", arg: (i) => str(i.command).split("\n")[0] },
  save_note: { verb: "Save note", arg: (i) => str(i.title) },
  delete_note: { verb: "Delete note", arg: (i) => str(i.title) || str(i.id) },
};

export function toolMeta(name: string, input: unknown) {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const meta = META[name];
  if (!meta) {
    const first = Object.values(record).find((v) => typeof v === "string");
    return { verb: name, arg: str(first) };
  }
  const folder = str(record.folder);
  const arg = meta.arg(record);
  return { verb: meta.verb, arg: folder && arg ? `${folder}:${arg}` : arg };
}

export type SpawnInput = { role: string; title: string; task: string; tier: string };

export function spawnInput(input: unknown): SpawnInput {
  const r = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return { role: str(r.role), title: str(r.title), task: str(r.task), tier: str(r.tier) };
}
