import { Play } from "lucide-react";
import { useState } from "react";
import type { MenuItem } from "../primitives/Menu";
import { settingsHref } from "../../lib/route";
import { IconMenu } from "../primitives/IconMenu";
import { MenuButton } from "../primitives/MenuButton";
import { Presence } from "../primitives/Presence";
import { useRuns } from "./RunsContext";
import { SuggestionsDialog } from "./SuggestionsDialog";

/**
 * The review's Run menu: "Run ▾" with every command this review offers (pinned ones first; a running one shows its output),
 * the runs so far, and a way to add commands from `package.json`, the Makefile or the justfile. Commands run in the review's
 * own copy of the code, never in the user's folder.
 */
export function RunBar() {
  const r = useRuns();
  const [suggest, setSuggest] = useState(false);
  if (!r.api) return null;
  const gone = !r.worktreePresent ? "This review's copy of the code was removed. Refresh the review to run commands." : undefined;
  // B2 (polish pass F3): the header has one Run menu; the pinned commands lead it instead of standing beside it as buttons.
  const ordered = [...r.offered.filter((c) => c.pinned), ...r.offered.filter((c) => !c.pinned)];
  const items: MenuItem[] = [
    ...ordered.map((c): MenuItem => {
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
      {/* Polish step 6b (R3): the review header folds by its own width (container `rh`, `review/ReviewHeader`): below 1024 the
          pinned commands live only in this menu, below 480 the menu is its play glyph. 28px like the header's other controls. */}
      <span className="flex @max-[480px]/rh:hidden">
        <MenuButton label="Run a command" size="sm" text={r.running.size > 0 ? "Running…" : "Run"} alignEnd items={items} />
      </span>
      <span className="flex @min-[480px]/rh:hidden">
        <IconMenu label="Run a command" icon={Play} items={items} />
      </span>
      <Presence show={suggest}>{suggest && <SuggestionsDialog onClose={() => setSuggest(false)} />}</Presence>
    </>
  );
}
