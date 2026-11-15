import { useEffect, useState } from "react";
import type { CommandSuggestion } from "@octo/agent-client";
import { commandFromSuggestion, commandsProblem, openSuggestions } from "../../lib/commands/config";
import { errorMessage } from "../../lib/format";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { SkeletonRows } from "../primitives/InfoList";
import { useRuns } from "./RunsContext";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; list: CommandSuggestion[] };

/** What the project's own files suggest (shown, never run): each "Add" puts it into the project's commands. */
export function SuggestionsDialog({ onClose }: { onClose(): void }) {
  const { api } = useRuns();
  const { project, update } = useProject();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.suggestions().then(
      (list) => alive && setLoad({ status: "ready", list }),
      (e: unknown) => alive && setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const add = async (s: CommandSuggestion) => {
    const have = project?.commands ?? [];
    const next = [...have, commandFromSuggestion(s, have)];
    const bad = commandsProblem(next);
    if (bad) return setProblem(bad);
    setBusy(s.name);
    setProblem(null);
    try {
      await update({ commands: next });
      setLoad((l) => (l.status === "ready" ? { status: "ready", list: l.list.map((x) => (x === s ? { ...x, configured: true } : x)) } : l));
    } catch (e) {
      setProblem(`${errorMessage(e).replace(/\.$/, "")}. Nothing was added; try again.`);
    } finally {
      setBusy(null);
    }
  };

  const open = load.status === "ready" ? openSuggestions(load.list) : [];
  return (
    <Dialog
      title="Add commands from this project"
      description="Read from package.json, the Makefile and the justfile. Nothing runs until you press Run."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        {load.status === "loading" && <SkeletonRows count={4} />}
        {load.status === "error" && (
          <p role="alert" className="text-err">
            The suggestions did not load: {load.message}. Close this and try again.
          </p>
        )}
        {load.status === "ready" && open.length === 0 && <p className="text-fg-3">Everything the project's files suggest is already a command.</p>}
        {open.length > 0 && (
          <ul className="flex flex-col gap-1">
            {open.map((s) => (
              <li key={`${s.source}:${s.name}`} className="flex min-h-10 items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-fg">{s.name}</span>
                  <span className="truncate font-mono text-xs text-fg-3">
                    {s.command} · {s.source}
                  </span>
                </span>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void add(s)} className="max-md:h-10">
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
        {problem && (
          <p role="alert" className="text-xs text-err">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}
