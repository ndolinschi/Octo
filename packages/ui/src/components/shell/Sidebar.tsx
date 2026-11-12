import { GitPullRequest, House, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { navigate } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { useMemo, useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useNow, useScrollFade } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
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
  /** Opens the Review tab of the open project. */
  onReview(): void;
  onSettings(): void;
  /** A project row was picked (closes the drawer). */
  onPick(): void;
}) {
  const { projects, health } = useApp();
  const now = useNow(true, CLOCK_SIDEBAR_MS);
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
    <nav aria-label="Projects" className="flex h-full w-sidebar shrink-0 flex-col bg-window pl-gutter">
      <div className="flex min-h-0 flex-1 flex-col p-pane">
        <div className="flex shrink-0 flex-col">
          <NavRow icon={House} label="Home" onClick={() => navigate(null)} current={props.home} disabled={!projects?.length} />
          <NavRow icon={Search} label="Search" onClick={props.onSearch} shortcut={{ hint: `${MOD}K`, keys: "Control+K Meta+K" }} />
          <NavRow icon={GitPullRequest} label="Review" onClick={props.onReview} disabled={props.activeProjectId === null} />
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
        </div>
      </div>
    </nav>
  );
}
