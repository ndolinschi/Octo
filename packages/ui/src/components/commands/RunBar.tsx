import { useState } from "react";
import type { MenuItem } from "../primitives/Menu";
import { settingsHref } from "../../lib/route";
import { Button } from "../primitives/Button";
import { MenuButton } from "../primitives/MenuButton";
import { Presence } from "../primitives/Presence";
import { Spinner } from "../primitives/Status";
import { useRuns } from "./RunsContext";
import { SuggestionsDialog } from "./SuggestionsDialog";

/** Pinned commands shown as buttons in the review header (decision 68: at most two). */
const PINNED_SHOWN = 2;

/**
 * Run buttons of a review: the pinned commands as quiet buttons (a spinner while that command runs; clicking a running
 * one shows its output), and "Run ▾" with every command this review offers, the runs so far, and a way to add commands
 * from `package.json`, the Makefile or the justfile. Commands run in the review's own worktree, never in the user's folder.
 */
export function RunBar() {
  const r = useRuns();
  const [suggest, setSuggest] = useState(false);
  if (!r.api) return null;
  const pinned = r.offered.filter((c) => c.pinned).slice(0, PINNED_SHOWN);
  const gone = !r.worktreePresent ? "This review's worktree was removed. Refresh the review to run commands." : undefined;
  const items: MenuItem[] = [
    ...r.offered.map((c): MenuItem => {
      const busy = r.running.has(c.name.toLowerCase());
      return {
        id: `run:${c.name}`,
        label: busy ? `${c.name} (running)` : c.name,
        title: gone ?? c.command,
        disabled: gone !== undefined,
        run: () => (busy ? r.openPanel() : void r.start(c.name)),
      };
    }),
    ...(r.offered.length > 0 ? [{ id: "sep1", separator: true } as const] : []),
    ...(r.runs.length > 0 ? [{ id: "runs", label: `Show runs (${r.runs.length})`, run: r.openPanel }] : []),
    { id: "suggest", label: "Add commands from this project…", run: () => setSuggest(true) },
    { id: "settings", label: "Edit commands in Settings", run: () => void (window.location.hash = settingsHref("commands")) },
  ];
  return (
    <>
      {pinned.map((c) => {
        const busy = r.running.has(c.name.toLowerCase());
        return (
          <Button
            key={c.name}
            variant="ghost"
            size="sm"
            title={gone ?? c.command}
            disabled={gone !== undefined}
            aria-busy={busy}
            onClick={() => (busy ? r.openPanel() : void r.start(c.name))}
            className="max-md:h-10"
          >
            {busy && <Spinner />}
            {c.name}
          </Button>
        );
      })}
      <MenuButton label="Run a command" text="Run" alignEnd items={items} />
      <Presence show={suggest}>{suggest && <SuggestionsDialog onClose={() => setSuggest(false)} />}</Presence>
    </>
  );
}
