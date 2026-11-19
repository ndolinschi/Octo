import {
  BridgeError,
  type Bridge,
  type BranchesParams,
  type BranchesResult,
  type GitBranch,
  type RepoBranches,
  type SwitchBranchInput,
} from "@octo/agent-client";
import type { ProjectRecord } from "./store";

/**
 * Demo branches (UI decision 98): every git folder is its own repository with a few branches. Atlas API has two
 * repositories (atlas-api, atlas-web), Docs site has uncommitted changes (a switch is refused with the worktree
 * alternative), infra has 140 branches (paging), and "tokens" is not a git folder (no chip). A switch is also refused
 * while a session of the main checkout works (Orbit mobile at start).
 */

type DemoRepo = { branch: string; dirty: number; branches: { name: string; at: number; subject: string }[] };

const HOUR = 3_600_000;
const NOT_GIT = new Set(["tokens"]);
const DIRTY: Record<string, number> = { "docs-site": 3 };

function seedRepo(label: string, now: number): DemoRepo {
  const names: Record<string, string[]> = {
    "atlas-api": ["main", "fix/login-timeout", "feature/billing-export", "chore/deps-november", "release/2.4"],
    "atlas-web": ["develop", "main", "feat/dashboard-v2"],
    "docs-site": ["main", "redesign", "typo-fixes"],
    infra: ["main", ...Array.from({ length: 139 }, (_, i) => `env/region-${String(i + 1).padStart(3, "0")}`)],
  };
  const list = names[label] ?? ["main", "develop", "fix/flaky-tests"];
  return {
    branch: list[0] ?? "main",
    dirty: DIRTY[label] ?? 0,
    branches: list.map((name, i) => ({ name, at: now - (i + 1) * 3 * HOUR, subject: i === 0 ? "Merge pull request #212" : `Work on ${name}` })),
  };
}

function short(name: string): string {
  let h = 7;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(7, "0").slice(0, 7);
}

export function withDemoBranches(bridge: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const repos = new Map<string, DemoRepo>();
  const now = Date.now();
  const delay = () => new Promise((r) => setTimeout(r, 120));

  const repoOf = (pid: string, label: string): DemoRepo => {
    const key = `${pid}/${label}`;
    let r = repos.get(key);
    if (!r) {
      r = seedRepo(label, now);
      repos.set(key, r);
    }
    return r;
  };

  const folders = (pid: string) => {
    const rec = records.get(pid);
    if (!rec) throw new BridgeError(404, "not_found", "project not found");
    return rec.project.folders.filter((f) => !NOT_GIT.has(f.label));
  };

  const view = (pid: string, f: { id: string; label: string }, q: string, offset: number, limit: number, branchOverride?: string): RepoBranches => {
    const r = repoOf(pid, f.label);
    const current = branchOverride ?? r.branch;
    const sorted = [...r.branches].sort((a, b) => (a.name === current ? -1 : b.name === current ? 1 : b.at - a.at));
    const all = sorted.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
    const chunk: GitBranch[] = all.slice(offset, offset + limit).map((b) => ({
      name: b.name,
      current: b.name === current,
      ahead: 0,
      behind: 0,
      commit: { sha: short(b.name), subject: b.subject, date: new Date(b.at).toISOString() },
    }));
    const next = offset + chunk.length;
    return {
      folder_id: f.id,
      folder: f.label,
      folders: [f.label],
      repo_root: `/Users/maya/code/${f.label}`,
      repo_name: f.label,
      branch: current,
      detached: false,
      head: short(current),
      dirty_files: branchOverride === undefined ? r.dirty : 0,
      branches: chunk,
      total: all.length,
      ...(chunk.length > 0 && next < all.length ? { next_offset: next } : {}),
    };
  };

  const runningShared = async (pid: string): Promise<number> => {
    const list = (await bridge.listSessions?.(pid, { kind: "main", limit: 200 })) ?? [];
    return list.filter((s) => (s.workspace?.kind ?? "shared") === "shared" && (s.state === "working" || s.state === "waiting")).length;
  };

  const listBranches = async (pid: string, params: BranchesParams = {}): Promise<BranchesResult> => {
    await delay();
    const wid = params.workspace ?? "shared";
    let branch: string | undefined;
    if (wid !== "shared") {
      const ws = (await bridge.listWorkspaces?.(pid))?.find((w) => w.id === wid);
      if (!ws) throw new BridgeError(404, "workspace_not_found", "That workspace no longer exists.", { hint: "Choose another workspace." });
      branch = ws.branch ?? "octo/worktree";
    }
    const fs = folders(pid).filter((f) => !params.folder || f.id === params.folder || f.label === params.folder);
    const limit = Math.min(params.limit ?? 30, 100);
    return {
      workspace: wid,
      running_sessions: await runningShared(pid),
      repos: fs.map((f) => {
        const v = view(pid, f, params.q ?? "", params.offset ?? 0, limit, branch);
        // A worktree's branch exists only there: listed first, alone, when nothing narrows the list.
        if (branch !== undefined && !v.branches.some((b) => b.name === branch) && !params.q && !params.offset) {
          v.branches.unshift({
            name: branch,
            current: true,
            ahead: 0,
            behind: 0,
            commit: { sha: short(branch), subject: "Worktree", date: new Date().toISOString() },
          });
        }
        return v;
      }),
    };
  };

  const switchBranch = async (pid: string, input: SwitchBranchInput): Promise<RepoBranches> => {
    await delay();
    const all = folders(pid);
    const f = input.folder ? all.find((x) => x.id === input.folder || x.label === input.folder) : all[0];
    if (!f) {
      throw new BridgeError(409, "not_a_git_repository", "This folder is not in a git repository.", {
        hint: "Branches can be chosen only for a folder under git.",
      });
    }
    const r = repoOf(pid, f.label);
    const name = input.branch.trim();
    if (input.create) {
      if (!name || /\s|\.\.|^-/.test(name)) {
        throw new BridgeError(400, "invalid_branch_name", "That is not a valid branch name.", {
          hint: "Use letters, digits, dashes and slashes, without spaces or two dots in a row.",
          details: name,
        });
      }
      if (r.branches.some((b) => b.name === name))
        throw new BridgeError(409, "branch_exists", "A branch of that name exists already.", { hint: "Choose it from the list instead." });
    } else if (!r.branches.some((b) => b.name === name)) {
      throw new BridgeError(404, "branch_not_found", "There is no branch of that name in this repository.", {
        hint: "Choose a branch from the list, or create it.",
      });
    }
    const running = await runningShared(pid);
    if (running > 0) {
      throw new BridgeError(409, "checkout_in_use", "A session is working in the main checkout, so it stays on its branch.", {
        hint: "Start in a worktree from that branch instead, or wait until the session ends.",
        action: "use_worktree",
        details: `${running} running`,
      });
    }
    if (r.dirty > 0) {
      throw new BridgeError(409, "uncommitted_changes", "The main checkout has uncommitted changes, so it stays on its branch.", {
        hint: "Start in a worktree from that branch instead. Your changes stay where they are.",
        action: "use_worktree",
        details: "src/pages/index.astro, src/content/docs/intro.md, astro.config.mjs",
      });
    }
    if (input.create) r.branches.push({ name, at: Date.now(), subject: `Branched from ${r.branch}` });
    r.branch = name;
    return view(pid, f, "", 0, 30);
  };

  return { ...bridge, listBranches, switchBranch };
}
