import type { DirListing, FolderEntry } from "@octo/agent-client";
import { Check, Folder, FolderOpen, FolderX, GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { errorMessage } from "../../lib/format";
import { MOD_LABEL } from "../../lib/keys";
import {
  browseOutcome,
  browseRow,
  chosenFrom,
  completion,
  folderName,
  looksLikePath,
  mergeRecent,
  parentOf,
  rememberFolder,
  tildePath,
} from "../../lib/folderPick";
import { middleTruncate } from "../../lib/format";
import { rowMatches, type PickerRow, type PickerSection } from "../../lib/picker";
import { jsonCodec, PREFS, usePersistentState } from "../../lib/storage";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { Glyph } from "../primitives/Glyph";
import { Spinner } from "../primitives/Status";
import { Picker } from "../primitives/Picker";

const chosenCodec = jsonCodec(chosenFrom);
/** Path completion waits for a pause in typing. */
const DEBOUNCE_MS = 120;

type Load = { query: string; listing: DirListing | null; failed: boolean };

/**
 * Decision 49 — choosing a folder is a picker, never a typed path: a 320px popover (a sheet on small windows via the
 * Popover's limits) with the search field focused; Recent (folders chosen here and the folders of existing projects:
 * name, parent path, the git branch); "Browse…" (the host's system dialog, desktop only); and once the text looks like a
 * path, the matching directories live from the harness (`listDirs`), completed with ↑/↓ and `Tab`. A folder that does
 * not exist or cannot be read is said inline. Without `listDirs` (an older harness) it is Recent + Browse, plus "Use"
 * for a typed path.
 */
export function FolderPicker(props: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  /** Folders already chosen (checked). */
  current?: readonly string[];
  onChoose(path: string): void;
  onClose(): void;
  side?: "top" | "bottom";
}) {
  const { bridge, config } = useApp();
  const { pickFolder: hostPick } = useHost();
  // Decision 49: the system dialog from the host (the desktop shell) first, else the harness's (`pick_folder`).
  const bridgePick = bridge.pickFolder && config?.pick_folder === true ? bridge.pickFolder.bind(bridge) : null;
  const search = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [browse, setBrowse] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [chosen, setChosen] = usePersistentState(PREFS.chosenFolders, chosenCodec, { persistInitial: false });
  const [recent, setRecent] = useState<FolderEntry[]>([]);
  const [load, setLoad] = useState<Load | null>(null);
  const [query, setQuery] = useState("");
  const timer = useRef(0);
  const currentPaths = props.current;
  const current = useMemo(() => new Set((currentPaths ?? []).map((p) => p.replace(/[\\/]+$/, ""))), [currentPaths]);

  useEffect(() => {
    let alive = true;
    // An older harness has no recent list: the picker still offers what was chosen here, Browse and typed paths.
    bridge.recentFolders?.().then(
      (list) => alive && setRecent(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onQuery = (q: string) => {
    setQuery(q);
    window.clearTimeout(timer.current);
    if (!looksLikePath(q) || !bridge.listDirs) return;
    timer.current = window.setTimeout(() => {
      bridge.listDirs?.(q.trim()).then(
        (listing) => setLoad({ query: q, listing, failed: false }),
        () => setLoad({ query: q, listing: null, failed: true }),
      );
    }, DEBOUNCE_MS);
  };

  const canBrowse = hostPick !== undefined || bridgePick !== null;
  const startDir = parentOf((props.current ?? []).at(-1) ?? "");
  /** Opens the system dialog; the popover stays open meanwhile and the row says it is waiting. */
  const runBrowse = async () => {
    if (browse.busy || !canBrowse) return;
    setBrowse({ busy: true, error: null });
    const out = await (hostPick ? hostPick() : bridgePick ? bridgePick(startDir || undefined) : Promise.resolve(null)).then(browseOutcome, (e: unknown) => ({
      kind: "error" as const,
      message: errorMessage(e),
    }));
    if (!mounted.current) return;
    if (out.kind === "chosen") {
      setBrowse({ busy: false, error: null });
      choose(out.path);
      props.onClose();
    } else {
      setBrowse({ busy: false, error: out.kind === "error" ? out.message : null });
      if (out.kind === "cancelled") search.current?.focus();
    }
  };

  const choose = (path: string) => {
    setChosen((list) => rememberFolder(list, path));
    props.onChoose(path);
  };
  const row = (e: FolderEntry, section: string): PickerRow => {
    const parent = parentOf(e.path);
    const on = current.has(e.path.replace(/[\\/]+$/, ""));
    return {
      id: `${section}:${e.path}`,
      // The name keeps its room (the branch gives way first, then the name is cut in the middle); the path is a second dim line.
      label: middleTruncate(e.name || folderName(e.path), 30),
      ...(parent ? { sub: middleTruncate(tildePath(parent), 40) } : {}),
      ...(e.git ? { hint: e.git.branch } : {}),
      title: e.git ? `${e.path} (git: ${e.git.branch})` : e.path,
      lead: <Glyph icon={e.git ? GitBranch : on ? Check : Folder} size={14} />,
      checked: on,
      run: () => choose(e.path),
    };
  };

  /** A parent path that is the same on every row says nothing: it is dropped (the row's tooltip still has the full path). */
  const quiet = (rows: PickerRow[]): PickerRow[] => {
    if (rows.length < 2 || new Set(rows.map((r) => r.sub ?? "")).size > 1) return rows;
    return rows.map(({ sub: _sub, ...rest }) => rest);
  };

  const sections = (q: string): PickerSection[] => {
    const out: PickerSection[] = [];
    const typed = q.trim();
    if (canBrowse) {
      const b = browseRow(browse, `${MOD_LABEL}O`);
      const rows: PickerRow[] = [
        {
          id: "browse",
          label: b.label,
          ...(b.hint ? { hint: b.hint } : {}),
          lead: b.busy ? <Spinner /> : <Glyph icon={FolderOpen} size={14} />,
          title: "Choose a folder with the system dialog",
          disabled: b.disabled,
          busy: b.busy,
          keepOpen: true,
          run: () => void runBrowse(),
        },
      ];
      if (b.error)
        rows.push({
          id: "browse-error",
          label: "The folder dialog did not open",
          sub: b.error,
          lead: <Glyph icon={FolderX} size={14} />,
          title: b.error,
          disabled: true,
          run: () => undefined,
        });
      out.push({ title: "", rows });
    }
    if (looksLikePath(typed)) {
      if (bridge.listDirs) {
        const l = load?.query.trim() === typed ? load : null;
        if (l?.failed || l?.listing?.error) {
          out.push({
            title: "Folders",
            rows: [
              {
                id: "missing",
                label: l.listing?.error === "not_readable" ? `Can't read ${parentOf(typed) || typed}` : `No folder at ${parentOf(typed) || typed}`,
                lead: <Glyph icon={FolderX} size={14} />,
                disabled: true,
                run: () => undefined,
              },
            ],
          });
        } else if (l?.listing) {
          const rows = l.listing.entries.map((e) => row(e, "dir"));
          // The listed directory itself, when the text names it exactly ("/Users/maya/code/").
          const base = l.listing.base.replace(/[\\/]+$/, "");
          if (/[\\/]$/.test(typed) || typed.replace(/[\\/]+$/, "") === base)
            rows.unshift({
              ...row({ name: folderName(base), path: base, git: null }, "base"),
              label: `Use ${folderName(base)}`,
              lead: <Glyph icon={FolderOpen} size={14} />,
            });
          out.push({ title: rows.length ? "Folders" : "No folders here", rows: quiet(rows) });
        }
      } else {
        out.push({
          title: "Folder",
          rows: [{ id: "typed", label: `Use ${typed}`, lead: <Glyph icon={FolderOpen} size={14} />, title: typed, run: () => choose(typed) }],
        });
      }
    }
    const rec = mergeRecent(chosen, recent)
      .map((e) => row(e, "recent"))
      .filter((r) => looksLikePath(typed) || rowMatches(r, typed));
    if (rec.length) out.push({ title: "Recent", rows: quiet(rec) });
    return out;
  };

  return (
    <Picker
      anchor={props.anchor}
      label={props.label}
      placeholder={bridge.listDirs ? "Search recent folders or type a path" : "Search recent folders"}
      side={props.side ?? "bottom"}
      {...(props.side === "top" ? { gap: 4 } : {})}
      onQuery={onQuery}
      searchRef={search}
      onShortcut={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "o" && canBrowse) {
          void runBrowse();
          return true;
        }
        return false;
      }}
      complete={(r) => (r.id.startsWith("dir:") ? completion(r.id.slice(4)) : null)}
      sections={sections}
      empty={query ? "No folders match" : "No recent folders yet. Type a path to find one."}
      onClose={props.onClose}
    />
  );
}
