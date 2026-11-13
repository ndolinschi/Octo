import type { DirListing, FolderEntry } from "@octo/agent-client";

/** A fake home directory for the folder picker (decision 49): code folders, some git repositories, a hidden one. */
const TREE: Record<string, { git?: string } | undefined> = {
  "/Users/maya": undefined,
  "/Users/maya/code": undefined,
  "/Users/maya/code/atlas-api": { git: "main" },
  "/Users/maya/code/atlas-web": { git: "feat/refresh-lock" },
  "/Users/maya/code/orbit-app": { git: "rn-0.80" },
  "/Users/maya/code/docs-site": { git: "main" },
  "/Users/maya/code/ledger": { git: "main" },
  "/Users/maya/code/infra": { git: "staging-upgrade" },
  "/Users/maya/code/webhooks": { git: "main" },
  "/Users/maya/code/tokens": undefined,
  "/Users/maya/code/release": { git: "main" },
  "/Users/maya/code/changelog": undefined,
  "/Users/maya/code/stress-kit": undefined,
  "/Users/maya/code/sandbox": undefined,
  "/Users/maya/code/sandbox/rust-demo": { git: "main" },
  "/Users/maya/Documents": undefined,
  "/Users/maya/Documents/notes": undefined,
  "/Users/maya/Downloads": undefined,
  "/Users/maya/.config": undefined,
};
const HOME = "/Users/maya";

const entry = (path: string): FolderEntry => {
  const git = TREE[path]?.git;
  return { name: path.slice(path.lastIndexOf("/") + 1), path, git: git ? { branch: git } : null };
};

/** `GET /v1/fs/dirs?path=`: the children of the typed path's directory that start with its last segment. */
export function demoListDirs(raw: string): DirListing {
  const text = raw.replace(/^~/, HOME) || HOME;
  const slash = text.lastIndexOf("/");
  const base = slash <= 0 ? "/" : text.slice(0, slash);
  const prefix = text.slice(slash + 1).toLowerCase();
  if (base !== "/" && !(base in TREE) && !"/Users".startsWith(base)) return { base, entries: [], error: "not_found" };
  const all = Object.keys(TREE).concat(["/Users"]);
  const entries = [...new Set(all)]
    .filter((p) => p.slice(0, p.lastIndexOf("/") || 1) === base && p !== base)
    .filter((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      return name.toLowerCase().startsWith(prefix) && (!name.startsWith(".") || prefix.startsWith("."));
    })
    .sort()
    .slice(0, 50)
    .map(entry);
  return { base, entries };
}

/** `GET /v1/fs/recent`: the folders of existing projects, newest first. */
export function demoRecentFolders(projectFolders: readonly string[]): FolderEntry[] {
  return [...new Set(projectFolders)].slice(0, 8).map(entry);
}
