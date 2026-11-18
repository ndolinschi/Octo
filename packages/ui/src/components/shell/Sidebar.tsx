import { GitPullRequest, House, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { navigate } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { lazy, Suspense, type ReactNode } from "react";
import { useApp } from "../../state/app";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { ListRow } from "../primitives/ListRow";
import { SkeletonList } from "../primitives/Skeleton";
import { usePhone } from "../../lib/phone";
import { useHost } from "../../state/host";

/** The "Projects" view's list: its own chunk, asked for at once (decision 96: the default view is the tree, `SessionTree`). */
const listChunk = import("./ProjectList").catch(() => undefined);
const ProjectList = lazy(() => listChunk.then((m) => m ?? import("./ProjectList")).then((m) => ({ default: m.ProjectList })));

/** A nav row (decision 90): a 32px `ListRow` with its glyph, label and, when it has one, the key hint. */
/** `warm`: the lazy surface the row opens, warmed on hover, focus or press (`lib/warm`). */
function NavRow(props: {
  icon: LucideIcon;
  label: string;
  onClick(): void;
  disabled?: boolean;
  shortcut?: { hint: string; keys: string };
  current?: boolean;
  warm?: string;
}) {
  return (
    <ListRow
      size="md"
      leading={<Glyph icon={props.icon} size={16} className="text-fg-2" />}
      title={props.label}
      meta={props.shortcut?.hint}
      selected={props.current === true}
      disabled={props.disabled === true}
      onClick={props.onClick}
      data-warm={props.warm}
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
  showReview?: boolean;
  onSettings(): void;
  /** A project row was picked (closes the drawer). */
  onPick(): void;
  /** Decision 96: in place of the project list, the tree of projects and sessions (or the flat sessions list). */
  tree?: ReactNode;
}) {
  const { projects, health } = useApp();
  const canCreate = health === "online";
  const phone = usePhone();
  // Remote access: a device never creates a project (local only, and it needs the computer's folder dialog).
  const device = useHost().remoteDevice !== undefined;

  return (
    <nav
      aria-label="Projects"
      className="flex h-full w-sidebar shrink-0 flex-col bg-window pl-gutter phone:min-h-0 phone:w-full phone:flex-1 phone:bg-transparent phone:pl-0"
    >
      <div className="flex min-h-0 flex-1 flex-col p-pane">
        <div className="flex shrink-0 flex-col">
          <NavRow icon={House} label="Home" onClick={() => navigate(null)} current={props.home} disabled={!projects?.length} />
          <NavRow
            icon={Search}
            label="Search"
            warm="palette"
            onClick={props.onSearch}
            {...(phone ? {} : { shortcut: { hint: `${MOD}K`, keys: "Control+K Meta+K" } })}
          />
          {props.showReview !== false &&
            (props.activeProjectId === null ? (
              // Unavailable on Home: a focusable wrapper carries the reason (a disabled button gets no focus or tooltip).
              <span
                role="button"
                aria-disabled="true"
                tabIndex={0}
                aria-label="Review, unavailable: open a project first"
                title="Open a project first"
                className="rounded-sm focus-inset"
              >
                {/* 11c: the look of the row, not a second control inside the wrapper (no nested disabled button). */}
                <ListRow size="md" leading={<Glyph icon={GitPullRequest} size={16} className="text-fg-2" />} title="Review" disabled />
              </span>
            ) : (
              <NavRow icon={GitPullRequest} label="Review" warm="tool:review" onClick={props.onReview} />
            ))}
          {!device && <NavRow icon={Plus} label="New project" warm="project-dialog" onClick={props.onNewProject} disabled={!canCreate} />}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {props.tree ?? (
            <Suspense fallback={<SkeletonList count={3} size="lg" twoLine className="mt-4" />}>
              <ProjectList activeProjectId={props.activeProjectId} unseen={props.unseen} onNewProject={props.onNewProject} onPick={props.onPick} />
            </Suspense>
          )}
        </div>

        <div className="relative mt-2 shrink-0">
          <NavRow icon={Settings} label="Settings" warm="settings" onClick={props.onSettings} />
        </div>
      </div>
    </nav>
  );
}
