import { ArrowLeft, ArrowRight, House, PanelLeft, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { navigate } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { useMemo, useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useHistoryAvailability } from "../../lib/history";
import { useNow, useScrollFade } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { Spinner } from "../primitives/Status";
import { ProjectItem } from "./ProjectItem";
import { CLOCK_SIDEBAR_MS } from "../../lib/constants";

/**
 * Row anatomy shared by every sidebar row: [16px leading slot] 8 [label] flex [trailing], 8px padding,
 * radius 6. Nav rows are 32px; project rows 40px with two lines (name, the orchestrator's state).
 */
export const NAV_ROW = "press-row flex h-row-nav w-full items-center gap-2 rounded-sm px-2 text-sm text-fg hover:bg-hover";

function NavRow(props: {
  icon: LucideIcon;
  label: string;
  onClick(): void;
  disabled?: boolean;
  trailing?: ReactNode;
  shortcut?: { hint: string; keys: string };
  current?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-keyshortcuts={props.shortcut?.keys}
      aria-current={props.current ? "page" : undefined}
      className={cn(NAV_ROW, "disabled:text-fg-3 disabled:hover:bg-transparent", props.current && "bg-active hover:bg-active")}
    >
      <Glyph icon={Icon} size={16} className="shrink-0 text-fg-2" />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.shortcut && (
        <kbd aria-hidden className="shrink-0 font-sans text-xs text-fg-3">
          {props.shortcut.hint}
        </kbd>
      )}
    </button>
  );
}

/**
 * The sidebar is a borderless card on the window: 8px gutter to the window and to the first panel, 8px
 * inset to its rows (the panels' rule). Its header sits on the panels' tab-strip line.
 */
export function Sidebar(props: {
  activeProjectId: string | null;
  /** Home is showing (no project open). */
  home: boolean;
  /** Projects with activity the user has not seen (see `useUnseen`). */
  unseen: Set<string>;
  onNewProject(): void;
  onSearch(): void;
  onSettings(): void;
  /** A project row was picked (closes the drawer). */
  onPick(): void;
  /** Hides the inline sidebar, or closes the drawer. */
  onToggle(): void;
}) {
  const { projects, health } = useApp();
  const now = useNow(true, CLOCK_SIDEBAR_MS);
  const history = useHistoryAvailability();
  const list = useRef<HTMLUListElement>(null);
  useScrollFade(list, "y");
  const canCreate = health === "online";
  // Stable order (newest project first by creation), so rows never jump under the pointer as
  // activity changes `updated_at`; activity shows as the dot instead.
  const ordered = useMemo(
    () => (projects ? [...projects].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id)) : null),
    [projects],
  );
  const orchestrators = useOrchestrators(projects);

  return (
    <nav aria-label="Projects" className="flex h-full w-sidebar shrink-0 flex-col bg-window py-gutter pl-gutter max-sm:py-0">
      <div className="flex min-h-0 flex-1 flex-col p-pane">
        {/* 2px side padding: the toggle's glyph centres on the rows' leading slot, the last button's on their trailing edge. */}
        <div className="flex h-row shrink-0 items-center gap-1 px-0.5">
          <IconButton icon={PanelLeft} label="Hide sidebar" aria-expanded onClick={props.onToggle} />
          <span className="flex-1" />
          <IconButton icon={ArrowLeft} label="Back" onClick={() => window.history.back()} disabled={!history.back} />
          <IconButton icon={ArrowRight} label="Forward" onClick={() => window.history.forward()} disabled={!history.forward} />
        </div>

        <div className="mt-2 flex shrink-0 flex-col">
          <NavRow icon={House} label="Home" onClick={() => navigate(null)} current={props.home} disabled={!projects?.length} />
          <NavRow icon={Search} label="Search" onClick={props.onSearch} shortcut={{ hint: `${MOD}K`, keys: "Control+K Meta+K" }} />
          <NavRow icon={Plus} label="New project" onClick={props.onNewProject} disabled={!canCreate} />
        </div>

        {(projects ? projects.length > 0 : health !== "offline") && (
          <div className="mt-4 flex h-row shrink-0 items-center pr-0.5 pl-2">
            <h2 className="text-xs text-fg-3">Projects</h2>
            <IconButton icon={Plus} label="Add project" onClick={props.onNewProject} disabled={!canCreate} className="ml-auto" />
          </div>
        )}
        <ul ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain fade-y">
          {projects === null &&
            health !== "offline" &&
            [0, 1, 2].map((i) => (
              <li key={i} className="flex h-bar items-center gap-2 px-2" aria-hidden>
                <span className="size-4 shrink-0" />
                <span className="h-2 rounded-full bg-hover" style={{ width: `${62 - i * 14}%` }} />
              </li>
            ))}
          {ordered?.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              active={p.id === props.activeProjectId}
              unseen={props.unseen.has(p.id)}
              state={orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }}
              onPick={props.onPick}
              now={now}
            />
          ))}
        </ul>

        <div className="relative mt-2 shrink-0">
          <NavRow icon={Settings} label="Settings" onClick={props.onSettings} />
          <ConnectionStatus />
        </div>
      </div>
    </nav>
  );
}

/** Silent while the bridge is healthy; speaks up only when it is not (trailing slot of the Settings row). */
function ConnectionStatus() {
  const { health } = useApp();
  return (
    <span role="status" className="pointer-events-none absolute inset-y-0 right-2 flex max-w-[60%] min-w-0 items-center gap-2 text-xs text-fg-3">
      {health === "offline" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-err" />}
      {health === "checking" && <Spinner size={12} />}
      {health !== "online" && <span className="truncate">{health === "offline" ? "Bridge offline" : "Connecting…"}</span>}
    </span>
  );
}
