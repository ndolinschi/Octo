import { ChevronDown, ChevronRight, ChevronUp, MessageCircle, MessageSquare } from "lucide-react";
import type { ReviewFile, ReviewGroup } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { reasonLabel, splitPath, type FileSection } from "../../lib/review/files";
import { threadCountText } from "../../lib/review/threads";
import { IconButton } from "../primitives/IconButton";
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
  return (
    <nav aria-label="Changed files" className="flex flex-col gap-2 p-2">
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
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="shrink-0 font-medium">{s.label}</span>
                    <span className="min-w-0 truncate text-xs">
                      {s.files.length} folded: {[...new Set(s.files.map((f) => reasonLabel(f.reason)))].join(", ")}
                    </span>
                  </span>
                }
              />
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
          <Checkbox hideLabel label={`Viewed: ${f.path}`} checked={f.viewed} onChange={(next) => props.onViewed(f.path, next)} />
        </span>
      }
      leading={
        <span aria-label={f.status} className={cn("font-mono text-xs font-medium", STATUS_TONE[letter])}>
          {letter}
        </span>
      }
      title={
        // B28: the marks sit in the title, so the meta holds only the line counts (the meta stops at 40% of the row and clips
        // what is wider): the path gives way first (the directory, then the name from its middle), the marks and counts never shrink.
        <span className="flex min-w-0 items-center gap-2">
          <MiddleText text={name} className={cn(f.viewed && !f.changed_since_viewed && "text-fg-3")} />
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
            <bdi>{dir}</bdi>
          </span>
          {f.changed_since_viewed && (
            <span className="shrink-0 rounded-xs border border-line px-1 text-[11px] leading-4 text-warn" title="Changed since you viewed it">
              changed
            </span>
          )}
          {(f.threads ?? 0) > 0 && (
            <span
              className={cn("flex shrink-0 items-center gap-0.5 text-xs", unresolved > 0 ? "text-fg" : "text-fg-3")}
              title={threadCountText(f.threads ?? 0, unresolved)}
            >
              <Glyph icon={MessageCircle} size={14} />
              {unresolved > 0 ? unresolved : f.threads}
            </span>
          )}
          {f.pending_comments > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-xs text-fg-2" title={`${f.pending_comments} pending comments`}>
              <Glyph icon={MessageSquare} size={14} />
              {f.pending_comments}
            </span>
          )}
        </span>
      }
      meta={<LineStat file={f} />}
    />
  );
}

/** Narrow windows: the list becomes a picker above the diff, with previous / next. */
export function FilePicker(props: { sections: readonly FileSection[]; selected: string | null; onSelect(path: string): void; onStep(dir: 1 | -1): void }) {
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
    <div className="flex shrink-0 items-center gap-1 border-b border-line p-2">
      <Select
        id="review-file-picker"
        label="File"
        size="lg"
        value={props.selected ?? ""}
        placeholder="Choose a file"
        options={options}
        onChange={props.onSelect}
        className="min-w-0 flex-1"
      />
      <IconButton icon={ChevronUp} label="Previous file" size="lg" onClick={() => props.onStep(-1)} />
      <IconButton icon={ChevronDown} label="Next file" size="lg" onClick={() => props.onStep(1)} />
    </div>
  );
}
