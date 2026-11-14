import type { ProjectSummary } from "@octo/agent-client";
import { GitPullRequest, House, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { navigate } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { useMemo, useRef, type ReactNode } from "react";
import { useNow, useScrollFade } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/IconButton";
import { ListRow } from "../primitives/ListRow";
import { SkeletonList } from "../primitives/Skeleton";
import { ProjectItem } from "./ProjectItem";
import { CLOCK_SIDEBAR_MS } from "../../lib/constants";

/** A nav row (decision 90): a 32px `ListRow` with its glyph, label and, when it has one, the key hint. */
function NavRow(props: { icon: LucideIcon; label: string; onClick(): void; disabled?: boolean; shortcut?: { hint: string; keys: string }; current?: boolean }) {
  return (
    <ListRow
      size="md"
      leading={<Glyph icon={props.icon} size={16} className="text-fg-2" />}
      title={props.label}
      meta={props.shortcut?.hint}
      selected={props.current === true}
      disabled={props.disabled === true}
      onClick={props.onClick}
    />
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
  /** Mounted under a project row (the app passes the expandable list of its sessions). */
  projectExtra?: ((project: ProjectSummary, active: boolean) => ReactNode) | undefined;
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
          {props.activeProjectId === null ? (
            // Unavailable on Home: a focusable wrapper carries the reason (a disabled button gets no focus or tooltip).
            <span
              role="button"
              aria-disabled="true"
              tabIndex={0}
              aria-label="Review, unavailable: open a project first"
              title="Open a project first"
              className="rounded-sm focus-inset"
            >
              <NavRow icon={GitPullRequest} label="Review" onClick={props.onReview} disabled />
            </span>
          ) : (
            <NavRow icon={GitPullRequest} label="Review" onClick={props.onReview} />
          )}
          <NavRow icon={Plus} label="New project" onClick={props.onNewProject} disabled={!canCreate} />
        </div>

        {(projects ? projects.length > 0 : health !== "offline") && (
          // Polish step 2 (F1): the caption is a row of the same 32px, its text on the rows' text edge (8 inset + 16 glyph + 8).
          <div className="mt-4 flex h-row-nav shrink-0 items-center pr-0.5 pl-8">
            <h2 className="text-xs text-fg-3">Projects</h2>
            <IconButton icon={Plus} label="Add project" onClick={props.onNewProject} disabled={!canCreate} className="ml-auto" />
          </div>
        )}
        <ul ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain fade-y">
          {projects === null && health !== "offline" && <SkeletonList count={3} size="lg" twoLine />}
          {ordered?.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              active={p.id === props.activeProjectId}
              unseen={props.unseen.has(p.id)}
              state={orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }}
              onPick={props.onPick}
              extra={props.projectExtra?.(p, p.id === props.activeProjectId)}
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
