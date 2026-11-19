import { BridgeError, type BranchesResult, type RepoBranches } from "@octo/agent-client";
import { ChevronDown, GitBranch, GitBranchPlus, GitFork, MoveRight } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { branchSections, mergePage, type BranchRow } from "../../lib/branches";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { errorMessage, formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Picker, type PickerRow, type PickerSection } from "../primitives/Picker";
import { ErrorNotice } from "../shared/ErrorNotice";

const QUERY_DEBOUNCE_MS = 150;
const CHUNK = 30;

type Failure = { error: unknown; branch: string | null };

/**
 * The composer's branch picker (decision 98), a lazy chunk opened from the branch chip: the shared `Picker` (search field,
 * keyboard contract), one section per repository with its local branches (current first and checked), a "create" row
 * when the query names no branch, an "In a new worktree" section, and "Move to worktree…" for the session. Choosing a
 * branch asks the harness to switch the main checkout; a refusal (uncommitted changes, a session at work, git's own
 * refusal) is shown under the list with "Start in a worktree from <branch>" as the primary action. Nothing is forced.
 */
export function BranchPicker(props: {
  anchor: RefObject<HTMLElement | null>;
  projectId: string;
  /** Whether a worktree can be started from here (the bridge can make one for this session). */
  canWorktree: boolean;
  onClose(): void;
  onSwitched(result: BranchesResult): void;
  onWorktree(branch: string): Promise<void>;
  onMoveToWorktree?: (() => void) | undefined;
}) {
  const { bridge } = useApp();
  const [result, setResult] = useState<BranchesResult | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const seq = useRef(0);
  const { projectId } = props;

  useEffect(() => {
    const list = bridge.listBranches;
    if (!list) return;
    const n = ++seq.current;
    const t = setTimeout(
      () => {
        list
          .call(bridge, projectId, { limit: CHUNK, ...(query.trim() ? { q: query.trim() } : {}) })
          .then((r) => {
            if (n === seq.current) setResult(r);
          })
          .catch((error: unknown) => {
            if (n === seq.current) setFailure({ error, branch: null });
          });
      },
      result === null ? 0 : QUERY_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
    // `result` only picks the first load's delay; a new answer must not load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [bridge, projectId, query]);

  const more = (repo: RepoBranches) => {
    const list = bridge.listBranches;
    if (!list || repo.next_offset === undefined) return;
    setBusy(`more:${repo.folder_id}`);
    list
      .call(bridge, projectId, { folder: repo.folder_id, offset: repo.next_offset, limit: CHUNK, ...(query.trim() ? { q: query.trim() } : {}) })
      .then((r) => {
        const next = r.repos[0];
        if (!next) return;
        setResult((cur) => cur && { ...cur, repos: cur.repos.map((x) => (x.folder_id === repo.folder_id ? mergePage(x, next) : x)) });
      })
      .catch((error: unknown) => setFailure({ error, branch: null }))
      .finally(() => setBusy(null));
  };

  const switchTo = (repo: RepoBranches, branch: string, create: boolean) => {
    const sw = bridge.switchBranch;
    if (!sw) return;
    setBusy(`${create ? "create" : "branch"}:${repo.folder_id}:${branch}`);
    setFailure(null);
    sw.call(bridge, projectId, { branch, folder: repo.folder_id, ...(create ? { create: true } : {}) })
      .then((after) => {
        const next = result ? { ...result, repos: result.repos.map((x) => (x.folder_id === repo.folder_id ? after : x)) } : null;
        if (next) props.onSwitched(next);
        props.onClose();
      })
      .catch((error: unknown) => setFailure({ error, branch }))
      .finally(() => setBusy(null));
  };

  const worktree = (branch: string) => {
    setBusy(`worktree:${branch}`);
    setFailure(null);
    props
      .onWorktree(branch)
      .then(() => props.onClose())
      .catch((error: unknown) => setFailure({ error, branch: null }))
      .finally(() => setBusy(null));
  };

  const now = useNow(true, CLOCK_MINUTE_MS);
  const toRow = (r: BranchRow): PickerRow => {
    switch (r.kind) {
      case "branch": {
        const id = `branch:${r.repo.folder_id}:${r.name}`;
        return {
          id,
          label: r.name,
          hint: formatRelative(r.date, now),
          title: r.subject,
          lead: <Glyph icon={GitBranch} size={14} className="text-fg-3" />,
          checked: r.current,
          busy: busy === id,
          disabled: busy !== null,
          keepOpen: true,
          run: () => (r.current ? props.onClose() : switchTo(r.repo, r.name, false)),
        };
      }
      case "create": {
        const id = `create:${r.repo.folder_id}:${r.name}`;
        return {
          id,
          label: `Create branch “${r.name}”`,
          detail: `from ${r.from}`,
          lead: <Glyph icon={GitBranchPlus} size={14} className="text-fg-3" />,
          busy: busy === id,
          disabled: busy !== null,
          keepOpen: true,
          run: () => switchTo(r.repo, r.name, true),
        };
      }
      case "more": {
        const id = `more:${r.repo.folder_id}`;
        return {
          id,
          label: r.remaining > 0 ? `Show more (${r.remaining})` : "Show more",
          lead: <Glyph icon={ChevronDown} size={14} className="text-fg-3" />,
          busy: busy === id,
          disabled: busy !== null,
          keepOpen: true,
          run: () => more(r.repo),
        };
      }
      case "worktree": {
        const id = `worktree:${r.name}`;
        return {
          id,
          label: r.name,
          detail: "new worktree",
          title: `Start this session in a new worktree from ${r.name}; the main checkout stays as it is`,
          lead: <Glyph icon={GitFork} size={14} className="text-fg-3" />,
          busy: busy === id,
          disabled: busy !== null,
          keepOpen: true,
          run: () => worktree(r.name),
        };
      }
    }
  };

  const sections = (q: string): PickerSection[] => {
    if (!result) return [];
    const out: PickerSection[] = branchSections(result, q, { worktree: props.canWorktree }).map((s) => ({ title: s.title, rows: s.rows.map(toRow) }));
    if (props.onMoveToWorktree && !q.trim()) {
      const move = props.onMoveToWorktree;
      out.push({
        title: "Session",
        rows: [
          { id: "move", label: "Move to worktree…", lead: <Glyph icon={MoveRight} size={14} className="text-fg-3" />, disabled: busy !== null, run: move },
        ],
      });
    }
    return out;
  };

  const err = failure?.error;
  const fields =
    err instanceof BridgeError ? { message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.details ? { details: err.details } : {}) } : null;
  const offerWorktree = err instanceof BridgeError && err.action === "use_worktree" && props.canWorktree && failure?.branch;
  const footer = failure ? (
    <ErrorNotice
      data="branch-refusal"
      fields={fields}
      raw={fields ? null : errorMessage(err)}
      actions={
        offerWorktree ? (
          <Button size="sm" variant="primary" icon={GitFork} loading={busy === `worktree:${failure.branch}`} onClick={() => worktree(failure.branch ?? "")}>
            Start in a worktree from {failure.branch}
          </Button>
        ) : undefined
      }
    />
  ) : undefined;

  return (
    <Picker
      anchor={props.anchor}
      label="Choose a branch"
      placeholder="Switch branch…"
      sections={sections}
      empty={result ? "No matching branches" : "Loading branches…"}
      side="bottom"
      align="start"
      gap={4}
      onQuery={setQuery}
      footer={footer}
      onClose={props.onClose}
    />
  );
}
