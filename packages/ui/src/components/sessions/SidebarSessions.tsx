import type { ProjectSession } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { glyphOf, hasSeveral, SIDEBAR_SESSIONS, sidebarSessions } from "../../lib/sessions/model";
import { navigate } from "../../lib/route";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { requestSession } from "../../state/workspace/sessionsStart";
import { IconButton } from "../primitives/IconButton";
import { ListRow } from "../primitives/ListRow";
import { StateGlyph } from "../primitives/StateGlyph";

/**
 * Under a project row of the sidebar (mounted by `ProjectItem`): a project with more than one session gets a chevron at the
 * row's right edge that opens its five most recent main sessions and "All sessions". A row opens that project's Sessions tab
 * on that session. The sessions are read when the row mounts and again when the project's `updated_at` moves on.
 */
export function SidebarSessions(props: { projectId: string; updatedAt: string; active: boolean; onPick(): void }) {
  const { bridge } = useApp();
  const nav = useNav();
  const [list, setList] = useState<readonly ProjectSession[]>([]);
  const [open, setOpen] = useState(false);
  const read = bridge.listSessions;
  useEffect(() => {
    if (!read) return;
    let cancelled = false;
    // Limit: one more than the five shown, so "All sessions" knows there are more. A failed read leaves the row as it was.
    read.call(bridge, props.projectId, { kind: "main", limit: SIDEBAR_SESSIONS + 1 }).then(
      (sessions) => !cancelled && setList(sessions),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [read, bridge, props.projectId, props.updatedAt]);
  if (!hasSeveral(list)) return null;
  const { shown, more } = sidebarSessions(list);
  const show = (sessionId: string) => {
    requestSession(props.projectId, sessionId);
    const workspace = nav.workspace();
    // The open project's workspace is mounted: it opens the tab now; any other opens it when it mounts.
    if (props.active && workspace) workspace.openTool("sessions");
    else navigate(props.projectId);
    props.onPick();
  };
  return (
    <>
      <IconButton
        icon={ChevronRight}
        label={open ? "Hide sessions" : "Show recent sessions"}
        size="xs"
        aria-expanded={open}
        data-sessions-toggle
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // Polish step 2 (F1): centred on the 32px row (40 under touch) and exactly over the row's 24px meta column (the row's
          // 8px inset from the right), so it takes the meta's place and never covers the name's ellipsis.
          "absolute top-1 right-2 opacity-0 group-focus-within/p:opacity-100 group-hover/p:opacity-100 focus-visible:opacity-100 touch:top-2 touch:opacity-100",
          open && "opacity-100 [&_svg]:rotate-90",
        )}
      />
      {open && (
        // Polish step 2 (F1): the sidebar's one rhythm (32px rows); a session's glyph sits on the project's text edge.
        <ul aria-label="Recent sessions" className="flex flex-col pb-1 pl-6">
          {shown.map((s) => (
            <li key={s.id}>
              <ListRow
                size="md"
                tone="quiet"
                leading={<StateGlyph state={glyphOf(s.state)} />}
                title={s.title}
                tip={s.title}
                meta={s.current ? "current" : undefined}
                onClick={() => show(s.id)}
              />
            </li>
          ))}
          <li>
            <ListRow size="md" tone="quiet" leading={<span />} title={more ? "All sessions" : "Open Sessions"} onClick={() => show("")} />
          </li>
        </ul>
      )}
    </>
  );
}
