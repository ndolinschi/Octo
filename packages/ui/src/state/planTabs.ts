import type { Plan } from "@octo/agent-client";
import { useSyncExternalStore } from "react";

export type PlanTabEntry = { plan: Plan; title: string };

const plans = new Map<string, PlanTabEntry>();
const revs = new Map<string, number>();
const subs = new Map<string, Set<() => void>>();

function bump(pid: string): void {
  revs.set(pid, (revs.get(pid) ?? 0) + 1);
  subs.get(pid)?.forEach((fn) => fn());
}

/** Cached plan and its derived title for a project's `plan:<id>` tab (written by `PlanCard` and `PlanTab`). */
export function getPlanTabState(pid: string, planId: string): PlanTabEntry | undefined {
  return plans.get(`${pid}:${planId}`);
}

/** Stores or updates a plan in the tab cache and notifies subscribers for `pid`. */
export function setPlanTabState(pid: string, plan: Plan, title: string): void {
  const key = `${pid}:${plan.id}`;
  const prev = plans.get(key);
  if (prev?.plan.status === plan.status && prev.plan.text === plan.text && prev.plan.approved_at === plan.approved_at && prev.title === title) return;
  plans.set(key, { plan, title });
  bump(pid);
}

/** Removes cached plans for turns rewound at or after `messageId`. */
export function dropPlansFromTurn(pid: string, messageId: number): void {
  const prefix = `${pid}:`;
  let changed = false;
  for (const [key, entry] of plans) {
    if (key.startsWith(prefix) && entry.plan.turn_id >= messageId) {
      plans.delete(key);
      changed = true;
    }
  }
  if (changed) bump(pid);
}

export function usePlanTabsRevision(pid: string): number {
  return useSyncExternalStore(
    (cb) => {
      let set = subs.get(pid);
      if (!set) subs.set(pid, (set = new Set()));
      set.add(cb);
      return () => void set.delete(cb);
    },
    () => revs.get(pid) ?? 0,
  );
}

export function usePlanTab(pid: string, planId: string): Plan | undefined {
  usePlanTabsRevision(pid);
  return getPlanTabState(pid, planId)?.plan;
}
