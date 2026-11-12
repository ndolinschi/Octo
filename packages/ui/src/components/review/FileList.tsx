import { ChevronDown, ChevronRight, ChevronUp, MessageSquare } from "lucide-react";
import type { ReviewFile, ReviewGroup } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { reasonLabel, splitPath, type FileSection } from "../../lib/review/files";
import { IconButton } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
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
  return (
    <nav aria-label="Changed files" className="flex flex-col gap-2 p-2">
      {props.sections.map((s) => {
        const open = !s.folded || props.opened.has(s.group);
        return (
          <section key={s.group} aria-label={`${s.label}, ${s.files.length} files`} className="flex flex-col">
            {s.folded ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => props.onToggleGroup(s.group)}
                className="flex h-7 w-full items-center gap-1 rounded-sm px-2 text-left text-xs text-fg-3 press-row focus-inset hover:bg-hover hover:text-fg max-md:h-10"
              >
                <Glyph icon={open ? ChevronDown : ChevronRight} size={14} />
                <span className="shrink-0 font-medium">{s.label}</span>
                <span className="min-w-0 truncate">
                  {s.files.length} folded: {[...new Set(s.files.map((f) => reasonLabel(f.reason)))].join(", ")}
                </span>
              </button>
            ) : (
              <h3 className="flex h-7 items-center px-2 text-xs font-medium text-fg-3">
                {s.label}
                <span className="ml-1.5 font-normal">{s.files.length}</span>
              </h3>
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
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className={cn("flex h-7 min-w-0 items-center rounded-sm max-md:h-10", props.selected ? "bg-active" : "hover:bg-hover")}>
      <label className="grid h-full w-7 shrink-0 cursor-pointer place-items-center max-md:w-10" title={f.viewed ? "Viewed (v)" : "Mark as viewed (v)"}>
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--octo-primary)]"
          checked={f.viewed}
          aria-label={`Viewed: ${f.path}`}
          onChange={(e) => props.onViewed(f.path, e.target.checked)}
        />
      </label>
      <button
        type="button"
        data-row
        data-path={f.path}
        aria-current={props.selected ? "true" : undefined}
        title={`${f.path}${note ? ` (${note})` : ""}`}
        onClick={() => props.onSelect(f.path)}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pr-2 text-left text-sm press-row focus-inset",
          props.selected ? "text-fg" : "text-fg-2",
        )}
      >
        <span aria-label={f.status} className={cn("w-3 shrink-0 text-center font-mono text-xs font-medium", STATUS_TONE[letter])}>
          {letter}
        </span>
        <span className={cn("shrink-0 truncate", f.viewed && !f.changed_since_viewed && "text-fg-3")}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
          <bdi>{dir}</bdi>
        </span>
        {f.changed_since_viewed && (
          <span className="shrink-0 rounded-xs border border-warn/50 px-1 text-[11px] leading-4 text-warn" title="Changed since you viewed it">
            changed
          </span>
        )}
        {f.pending_comments > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-fg-2" title={`${f.pending_comments} pending comments`}>
            <Glyph icon={MessageSquare} size={14} />
            {f.pending_comments}
          </span>
        )}
        <LineStat file={f} />
      </button>
    </div>
  );
}

/** Narrow windows: the list becomes a picker above the diff, with previous / next. */
export function FilePicker(props: { sections: readonly FileSection[]; selected: string | null; onSelect(path: string): void; onStep(dir: 1 | -1): void }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line p-2">
      <label className="sr-only" htmlFor="review-file-picker">
        File
      </label>
      <select
        id="review-file-picker"
        value={props.selected ?? ""}
        onChange={(e) => props.onSelect(e.target.value)}
        className="h-10 min-w-0 flex-1 rounded-md border border-input-border bg-panel px-2 text-input-touch text-fg focus:border-fg focus:outline-none"
      >
        {props.selected === null && <option value="">Choose a file</option>}
        {props.sections.map((s) => (
          <optgroup key={s.group} label={`${s.label} (${s.files.length})`}>
            {s.files.map((f) => (
              <option key={f.path} value={f.path}>
                {f.viewed ? "✓ " : ""}
                {f.path}
                {f.changed_since_viewed ? " (changed)" : ""}
                {f.pending_comments ? ` · ${f.pending_comments} pending` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <IconButton icon={ChevronUp} label="Previous file" className="size-10" onClick={() => props.onStep(-1)} />
      <IconButton icon={ChevronDown} label="Next file" className="size-10" onClick={() => props.onStep(1)} />
    </div>
  );
}
