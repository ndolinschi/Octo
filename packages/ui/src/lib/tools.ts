export const SPAWN_TOOL = "spawn_agent";

type ToolMeta = { verb: string; arg: (input: Record<string, unknown>) => string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

const META: Record<string, ToolMeta> = {
  list_dir: { verb: "Listed", arg: (i) => str(i.path) || "." },
  read_file: { verb: "Read", arg: (i) => str(i.path) },
  write_file: { verb: "Wrote", arg: (i) => str(i.path) },
  bash: { verb: "Ran", arg: (i) => str(i.command).split("\n")[0] },
  save_note: { verb: "Saved note", arg: (i) => str(i.title) },
  delete_note: { verb: "Deleted note", arg: (i) => str(i.title) || str(i.id) },
};

/** Past-tense verb, the main argument, and the project folder it ran in (if any). */
export function toolMeta(name: string, input: unknown): { verb: string; arg: string; folder: string } {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const meta = META[name];
  if (!meta) {
    const first = Object.values(record).find((v) => typeof v === "string");
    return { verb: `Called ${name}`, arg: str(first), folder: "" };
  }
  return { verb: meta.verb, arg: meta.arg(record), folder: str(record.folder) };
}

/** The file or folder path a tool call operates on, if it has one. */
export function toolPath(name: string, input: unknown): string {
  if (name !== "read_file" && name !== "write_file" && name !== "list_dir") return "";
  return typeof input === "object" && input !== null ? str((input as Record<string, unknown>).path) : "";
}

export type SpawnInput = { role: string; title: string; task: string; tier: string };

export function spawnInput(input: unknown): SpawnInput {
  const r = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return { role: str(r.role), title: str(r.title), task: str(r.task), tier: str(r.tier) };
}
