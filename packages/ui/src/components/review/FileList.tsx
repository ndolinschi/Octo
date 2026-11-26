import { ChevronDown, ChevronRight, MessageCircle, MessageSquare } from "lucide-react";
import { useRef } from "react";
import { useListStops } from "../../lib/listStops";
import type { ReviewFile, ReviewGroup } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { reasonLabel, splitPath, type FileSection } from "../../lib/review/files";
import { threadCountText } from "../../lib/review/threads";
import { Checkbox } from "../primitives/Checkbox";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { MiddleText } from "../primitives/MiddleText";
import { Select, type SelectOption } from "../primitives/Select";
import { LineStat } from "./parts";

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechange: "T" } as const;
const STATUS_TONE = { A: "text-ok", M: "text-fg-3", D: "text-err", R: "text-fg-3", C: "text-fg-3", T: "text-fg-3" } as const;

/**
 * The changed files in the API's reading order, grouped: core, callers, tests, other, and the mechanical group folded.
 * Each row: a "viewed" checkbox (`v`), the file, a mark when it changed after it was viewed, pending comments, size.
 */
export function FileList(props: {
  sections: readonly FileSection[];
  selected: string | null;
  opened: ReadonlySet<ReviewGroup>;
  onToggleGroup(group: ReviewGroup): void;
  onSelect(path: string): void;
  onViewed(path: string, viewed: boolean): void;
}) {
  // Item 9 (polish pass F3): the list is one Tab stop (↑/↓/Home/End between files and folded groups); "Viewed" is `v`.
  const nav = useRef<HTMLElement>(null);
  useListStops(nav);
  return (
    <nav ref={nav} aria-label="Changed files" className="flex flex-col gap-2 px-pane pt-1 pb-2">
      {props.sections.map((s) => {
        const open = !s.folded || props.opened.has(s.group);
        return (
          <section key={s.group} aria-label={`${s.label}, ${s.files.length} files`} className="flex flex-col">
            {s.folded ? (
              <ListRow
                size="sm"
                tone="quiet"
                expanded={open}
                onClick={() => props.onToggleGroup(s.group)}
                leading={<Glyph icon={open ? ChevronDown : ChevronRight} size={14} />}
                title={
                  // R4: a folded group's head reads as the other group heads (a caption), its reasons dim after the count.
                  <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
                    <span className="shrink-0 font-medium text-fg-3">{s.label}</span>
                    <span className="shrink-0 text-fg-3">{s.files.length}</span>
                    <span className="min-w-0 truncate text-fg-3">· {[...new Set(s.files.map((f) => reasonLabel(f.reason)))].join(", ")}</span>
                  </span>
                }
              />
            ) : (
              <h2 className="flex h-ctl-sm items-center gap-1.5 px-2 text-xs font-medium text-fg-3">
                {s.label}
                <span className="font-normal">{s.files.length}</span>
              </h2>
            )}
            {open && (
              <ul className="flex flex-col">
                {s.files.map((f) => (
                  <li key={f.path}>
                    <FileRow file={f} selected={props.selected === f.path} onSelect={props.onSelect} onViewed={props.onViewed} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}

function FileRow(props: { file: ReviewFile; selected: boolean; onSelect(path: string): void; onViewed(path: string, viewed: boolean): void }) {
  const f = props.file;
  const { dir, name } = splitPath(f.path);
  const letter = STATUS_LETTER[f.status];
  const note = [
    f.old_path ? `renamed from ${f.old_path}` : "",
    f.changed_since_viewed ? "changed since you viewed it" : "",
    f.pending_comments ? `${f.pending_comments} pending` : "",
    threadCountText(f.threads ?? 0, f.unresolved_threads ?? 0),
  ]
    .filter(Boolean)
    .join(", ");
  const unresolved = f.unresolved_threads ?? 0;
  return (
    <ListRow
      size="sm"
      tone={props.selected ? "default" : "quiet"}
      selected={props.selected}
      tip={`${f.path}${note ? ` (${note})` : ""}`}
      onClick={() => props.onSelect(f.path)}
      control={
        <span title={f.viewed ? "Viewed (v)" : "Mark as viewed (v)"}>
          <Checkbox hideLabel data-row-control label={`Viewed: ${f.path}`} checked={f.viewed} onChange={(next) => props.onViewed(f.path, next)} />
        </span>
      }
      leading={
        <span aria-label={f.status} className={cn("font-mono text-xs font-medium", STATUS_TONE[letter])}>
          {letter}
        </span>
      }
      title={
        // B28: marks stay in a shrink-0 trailing cluster before the line counts, so the directory truncates cleanly
        // left-to-right before them (never colliding into "…ices changed"), then the file name from its middle.
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <MiddleText text={name} className={cn(f.viewed && !f.changed_since_viewed && "text-fg-3")} />
            {dir && <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{dir}</span>}
          </span>
          {(f.changed_since_viewed || (f.threads ?? 0) > 0 || f.pending_comments > 0) && (
            <span className="flex shrink-0 items-center gap-1.5">
              {f.changed_since_viewed && (
                <span className="shrink-0 rounded-xs bg-hover px-1.5 text-xs leading-4 text-warn" title="Changed since you viewed it">
                  changed
                </span>
              )}
              {(f.threads ?? 0) > 0 && (
                <span
                  className={cn("flex shrink-0 items-center gap-0.5 text-xs tabular-nums", unresolved > 0 ? "text-fg" : "text-fg-3")}
                  title={threadCountText(f.threads ?? 0, unresolved)}
                >
                  <Glyph icon={MessageCircle} size={14} />
                  {unresolved > 0 ? unresolved : f.threads}
                </span>
              )}
              {f.pending_comments > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-fg-2 tabular-nums" title={`${f.pending_comments} pending comments`}>
                  <Glyph icon={MessageSquare} size={14} />
                  {f.pending_comments}
                </span>
              )}
            </span>
          )}
        </span>
      }
      meta={<LineStat file={f} />}
    />
  );
}

/** Page mode: the list becomes a picker in the diff's bar (R6, polish step 6b); previous / next file are in the bar's "⋯". */
export function FilePicker(props: { sections: readonly FileSection[]; selected: string | null; onSelect(path: string): void }) {
  const options: SelectOption[] = props.sections.flatMap((s) =>
    s.files.map((f) => ({
      value: f.path,
      group: `${s.label} (${s.files.length})`,
      label: [
        f.viewed ? "✓ " : "",
        f.path,
        f.changed_since_viewed ? " (changed)" : "",
        f.pending_comments ? ` · ${f.pending_comments} pending` : "",
        f.unresolved_threads ? ` · ${f.unresolved_threads} unresolved` : "",
      ].join(""),
    })),
  );
  return (
    <Select
      id="review-file-picker"
      label="File"
      size="sm"
      value={props.selected ?? ""}
      placeholder="Choose a file"
      options={options}
      onChange={props.onSelect}
      className="min-w-0 flex-1"
    />
  );
}
