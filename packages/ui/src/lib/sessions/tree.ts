import type { ProjectSession, ProjectSessionState } from "@octo/agent-client";
import type { GlyphState } from "../stateGlyph";
import { formatRelative } from "../format";

/**
 * The sidebar's "Projects and sessions" tree (UI decision 96): which sessions an open project shows, the glyph that sums up a
 * project's sessions, the rows' meta, which projects are open, and the tree's keyboard. Pure; `SessionTree` draws it.
 */

/** An open project shows its five most recently active sessions, plus any at work or waiting beyond them. */
export const TREE_RECENT = 5;
/** "Show all (N)" shows up to this many in place; past it, "Open Sessions". */
export const TREE_ALL = 50;

/** What `GET /v1/sessions` adds to a session. */
export type Located = { project_id: string; project_name: string };

const activityMs = (s: Pick<ProjectSession, "last_activity_at" | "started_at">): number => {
  const t = Date.parse(s.last_activity_at || s.started_at);
  return Number.isNaN(t) ? 0 : t;
};
/** Newest activity first (ties: newest start, then id, so rows never swap places at random). */
export const byActivity = (a: ProjectSession, b: ProjectSession): number =>
  activityMs(b) - activityMs(a) || b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id);

/** A session that asks to be seen whatever its age: it works, waits for the person, or waits for a free slot. */
export const isLive = (s: Pick<ProjectSession, "state" | "needs_you">): boolean =>
  s.state === "working" || s.state === "waiting" || s.state === "queued" || s.needs_you === true;

/** A session stays hidden from the sidebar until a message is sent or queued in it (or it is running/ended). */
export const hasSessionMessages = (s: Pick<ProjectSession, "exchanges" | "state" | "needs_you" | "queued">): boolean =>
  s.exchanges > 0 || isLive(s) || s.state === "failed" || s.state === "stopped" || (s.queued ?? 0) > 0;

/** The main sessions a tree lists (not archived and non-empty), newest activity first. */
export function mainSessions<T extends ProjectSession>(list: readonly T[]): T[] {
  return list.filter((s) => s.kind === "main" && !s.archived && hasSessionMessages(s)).sort(byActivity);
}

/**
 * The sessions shown under an open project and how many are left out. Folded: the five newest, then every live one beyond
 * them (in the same order). "Show all": up to fifty.
 */
export function visibleSessions<T extends ProjectSession>(list: readonly T[], all: boolean): { shown: T[]; hidden: number } {
  const mains = mainSessions(list);
  if (all) {
    const shown = mains.slice(0, TREE_ALL);
    return { shown, hidden: mains.length - shown.length };
  }
  const shown = mains.filter((s, i) => i < TREE_RECENT || isLive(s));
  return { shown, hidden: mains.length - shown.length };
}

/** A session's state glyph (decision 29's family): waiting is "needs you", a queued one the dashed ring. */
export function sessionGlyph(s: Pick<ProjectSession, "state" | "needs_you">): GlyphState {
  if (s.state === "waiting" || s.needs_you === true) return "needs";
  const by: Record<ProjectSessionState, GlyphState> = {
    working: "working",
    waiting: "needs",
    queued: "queued",
    failed: "failed",
    idle: "idle",
    stopped: "stopped",
  };
  return by[s.state];
}

const RANK: Record<GlyphState, number> = { needs: 5, failed: 4, working: 3, queued: 2, unseen: 1, stopped: 0, idle: 0 };

/**
 * A project's glyph from its sessions: needs you > failed > working > queued > idle (unseen is the caller's, from the
 * project's activity); null without any session (the caller keeps the orchestrator's state). `running`: sessions working
 * (one waiting for the person says so with its glyph instead).
 */
export function projectSummary(list: readonly ProjectSession[]): { glyph: GlyphState | null; running: number } {
  const mains = list.filter((s) => s.kind === "main" && !s.archived && hasSessionMessages(s));
  let glyph: GlyphState | null = null;
  for (const s of mains) {
    const g = sessionGlyph(s);
    if (glyph === null || RANK[g] > RANK[glyph]) glyph = g;
  }
  return { glyph, running: mains.filter((s) => s.state === "working").length };
}

/** A session row's meta: nothing while it works (the glyph turns), "waiting" for a slot, else the time since its activity. */
export function sessionMeta(s: Pick<ProjectSession, "state" | "last_activity_at" | "started_at">, now: number): string | null {
  if (s.state === "working" || s.state === "waiting") return null;
  if (s.state === "queued") return "queued";
  return formatRelative(s.last_activity_at || s.started_at, now);
}

/** A session's title as a row shows it. */
export const sessionTitle = (s: Pick<ProjectSession, "title">): string => (s.title.trim() === "" ? "New session" : s.title.trim());

/**
 * Whether a project is open in the tree: what the person chose last (stored), else open when it is the active project or
 * has a session at work or waiting for them.
 */
export function isOpen(stored: Readonly<Record<string, boolean>>, projectId: string, active: boolean, live: boolean): boolean {
  return stored[projectId] ?? (active || live);
}

/** The stored open/closed choices: `{ [projectId]: boolean }`; anything else reads as no choice. */
export function parseOpen(parsed: unknown): Record<string, boolean> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
}

/** A row of the tree as the keyboard sees it, in screen order. */
export type KeyRow = { id: string; level: 1 | 2; open?: boolean; title: string };

/** What a key does on the tree (WAI-ARIA tree view): move focus, open or close a project, or nothing. */
export type TreeMove = { focus: number } | { toggle: string; open: boolean } | null;

/**
 * ↑/↓ move, Home/End jump, → opens a closed project or moves into an open one, ← closes an open project or goes from a
 * session to its project, a letter jumps to the next row whose title starts with it. Enter is the row's own click.
 */
export function treeKey(key: string, rows: readonly KeyRow[], at: number): TreeMove {
  const row = rows[at];
  if (!row) return null;
  switch (key) {
    case "ArrowDown":
      return at + 1 < rows.length ? { focus: at + 1 } : null;
    case "ArrowUp":
      return at > 0 ? { focus: at - 1 } : null;
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: rows.length - 1 };
    case "ArrowRight":
      if (row.level !== 1) return null;
      if (!row.open) return { toggle: row.id, open: true };
      return rows[at + 1]?.level === 2 ? { focus: at + 1 } : null;
    case "ArrowLeft": {
      if (row.level === 1) return row.open ? { toggle: row.id, open: false } : null;
      for (let i = at - 1; i >= 0; i--) if (rows[i]?.level === 1) return { focus: i };
      return null;
    }
    default: {
      if (key.length !== 1 || !/\S/.test(key)) return null;
      const k = key.toLowerCase();
      for (let step = 1; step <= rows.length; step++) {
        const i = (at + step) % rows.length;
        if (rows[i]?.title.trim().toLowerCase().startsWith(k)) return { focus: i };
      }
      return null;
    }
  }
}
