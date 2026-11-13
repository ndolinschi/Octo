import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ReviewComment, ReviewThread } from "@octo/agent-client";
import { plural } from "../../lib/review/files";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

/**
 * Threads of this file that cannot be drawn at a line: the code they were about changed (outdated), or, in one column,
 * they sit on the removed side. Listed under the toolbar, folded, never placed at a wrong line.
 */
export function ApartThreads(props: { threads: readonly ReviewThread[]; pending: ReadonlyMap<string, ReviewComment[]>; actions: ThreadActions; now: number }) {
  const [open, setOpen] = useState(false);
  if (props.threads.length === 0) return null;
  const outdated = props.threads.filter((t) => t.outdated).length;
  const label = outdated === props.threads.length ? plural(outdated, "outdated thread") : `${plural(props.threads.length, "thread")} not at a line`;
  return (
    <div className="flex max-h-72 shrink-0 flex-col border-b border-line">
      <ListRow
        size="sm"
        tone="quiet"
        expanded={open}
        leading={<Glyph icon={open ? ChevronDown : ChevronRight} size={14} />}
        title={label}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-3">
          {props.threads.map((t) => (
            <ThreadCard key={t.id} thread={t} pending={props.pending.get(t.id) ?? []} actions={props.actions} now={props.now} />
          ))}
        </div>
      )}
    </div>
  );
}
