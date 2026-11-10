import type { ProjectSummary } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { readPref, writePref } from "./storage";

/**
 * Unseen activity: a project is unseen when its `updated_at` is newer than the last value the
 * user saw while it was open. Projects never opened compare against the first-run time, so a
 * fresh install starts with nothing unseen. Stored in localStorage (guarded); in memory otherwise.
 */
type Seen = { since: string; projects: Record<string, string> };

function load(): Seen {
  try {
    const parsed = JSON.parse(readPref("seen") ?? "") as Seen;
    if (typeof parsed.since === "string" && parsed.projects && typeof parsed.projects === "object") return parsed;
  } catch {
    /* missing or malformed: start fresh */
  }
  const fresh = { since: new Date().toISOString(), projects: {} };
  writePref("seen", JSON.stringify(fresh));
  return fresh;
}

/** Ids of projects with unseen activity; marks the open project as seen as it changes. */
export function useUnseen(projects: ProjectSummary[] | null, openId: string | null): Set<string> {
  const [seen, setSeen] = useState(load);
  const open = projects?.find((p) => p.id === openId);

  useEffect(() => {
    if (!open || seen.projects[open.id] === open.updated_at) return;
    const next = { ...seen, projects: { ...seen.projects, [open.id]: open.updated_at } };
    // Forget deleted projects while we are writing anyway.
    if (projects) for (const id of Object.keys(next.projects)) if (!projects.some((p) => p.id === id)) delete next.projects[id];
    writePref("seen", JSON.stringify(next));
    setSeen(next);
  }, [open, seen, projects]);

  const unseen = new Set<string>();
  for (const p of projects ?? []) {
    if (p.id === openId) continue;
    const last = seen.projects[p.id] ?? seen.since;
    if (Date.parse(p.updated_at) > Date.parse(last)) unseen.add(p.id);
  }
  return unseen;
}
