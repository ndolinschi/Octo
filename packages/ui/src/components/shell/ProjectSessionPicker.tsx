import { Plus, SquareArrowOutUpRight } from "lucide-react";
import { useState, type RefObject } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { errorMessage, structuredError } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { filterSections, type PickerRow, type PickerSection } from "../../lib/picker";
import { sessionChoiceMeta, sessionChoices } from "../../lib/sessions/picker";
import { sessionGlyph, sessionTitle } from "../../lib/sessions/tree";
import { useProject } from "../../state/project";
import { allTabs, sessionTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { IconButton } from "../primitives/IconButton";
import { Notice } from "../primitives/Notice";
import { Picker } from "../primitives/Picker";
import { StateGlyph } from "../primitives/StateGlyph";
import { useCreateProjectSession, useSyncProjectSessions } from "./sessionSwitcher";

/**
 * Searchable session switcher opened from the workspace header's Sessions button: switches `Chat` to any main session
 * (or opens it in a side-by-side tab), starts a new session, or jumps to the full Sessions panel. Lazy-loaded on open.
 */
export default function ProjectSessionPicker({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose(): void }) {
  const ws = useOptionalWorkspace();
  const { project, state } = useProject();
  const createSession = useCreateProjectSession();
  const now = useNow(false, CLOCK_MINUTE_MS);
  const [creating, setCreating] = useState<"show" | "tab" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useSyncProjectSessions(Boolean(project));
  if (!project) return null;

  const activeId = ws?.chatSessionId ?? state.sessions.defaultId;
  const open = new Set(ws ? allTabs(ws.layout) : []);
  const sessions = sessionChoices(state.sessions.list);

  const handleCreate = async (target: "show" | "tab") => {
    if (creating !== null) return;
    setError(null);
    setCreating(target);
    try {
      const created = await createSession(target);
      if (created) onClose();
      else setCreating(null);
    } catch (e) {
      setError(structuredError(e)?.message ?? errorMessage(e));
      setCreating(null);
    }
  };

  const sections = (query: string): PickerSection[] => {
    const sessionRows: PickerRow[] = sessions.map((s) => {
      const title = sessionTitle(s);
      const meta = sessionChoiceMeta(s, { activeId, openTab: open.has(sessionTab(s.id)), now });
      return {
        id: `session:${s.id}`,
        label: title,
        lead: <StateGlyph state={sessionGlyph(s)} size={12} box={16} />,
        checked: s.id === activeId,
        ...meta,
        ...(ws
          ? {
              trailing: (
                <IconButton
                  icon={SquareArrowOutUpRight}
                  size="xs"
                  tabIndex={-1}
                  label={`Open ${title} in new tab`}
                  title="Open in new tab"
                  className="pointer-events-none -mr-1 opacity-0 transition-opacity duration-fast group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                    ws.openSession(s.id);
                  }}
                />
              ),
            }
          : {}),
        disabled: !ws,
        run: () => ws?.showSession(s.id),
      };
    });
    const actions: PickerRow[] = [
      {
        id: "new-session",
        label: "New session",
        lead: <Glyph icon={Plus} size={14} />,
        detail: "Switch Chat",
        keepOpen: true,
        busy: creating === "show",
        disabled: !ws || creating !== null,
        run: () => void handleCreate("show"),
      },
      {
        id: "new-session-tab",
        label: "New session in new tab",
        lead: <Glyph icon={SquareArrowOutUpRight} size={14} />,
        keepOpen: true,
        busy: creating === "tab",
        disabled: !ws || creating !== null,
        run: () => void handleCreate("tab"),
      },
      {
        id: "all-sessions",
        label: "All sessions…",
        lead: <Glyph icon={GLYPH.sessions} size={14} />,
        disabled: !ws,
        run: () => ws?.openTool("sessions"),
      },
    ];
    return filterSections(
      [
        { title: "Sessions", rows: sessionRows },
        { title: "", rows: actions },
      ],
      query,
    );
  };

  return (
    <Picker
      anchor={anchor}
      label="Project sessions"
      placeholder="Switch or start a session"
      align="end"
      sections={sections}
      onClose={onClose}
      footer={
        error ? (
          <div className="border-t border-line px-3 py-2">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : undefined
      }
    />
  );
}
