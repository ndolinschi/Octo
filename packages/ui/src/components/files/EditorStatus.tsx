import { CircleAlert, CircleX, Info } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooksMore";
import type { EditorIntel, Problem, ProblemSeverity } from "../../lsp/hub";
import { Button } from "../primitives/Button";
import { ListRow } from "../primitives/ListRow";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";
import { StateGlyph } from "../primitives/StateGlyph";
import type { GlyphState } from "../../lib/stateGlyph";
import { splitKey, type FileKey } from "../../lib/files";
import { languageOfPath } from "../../lib/languages";

const STATE_TEXT = { starting: "starting…", ready: "ready", failed: "failed", stopped: "stopped" } as const;
/** The server's state in the app's one glyph family (polish step 4, E1): ready is the quiet idle dot. */
const GLYPH = { starting: "working", ready: "idle", failed: "failed", stopped: "failed" } as const satisfies Record<keyof typeof STATE_TEXT, GlyphState>;

const LANGUAGE: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  go: "Go",
  python: "Python",
  rust: "Rust",
  yaml: "YAML",
  json: "JSON",
  toml: "TOML",
  markdown: "Markdown",
  css: "CSS",
  html: "HTML",
  shellscript: "Shell",
  java: "Java",
  ruby: "Ruby",
  c: "C",
  cpp: "C++",
  csharp: "C#",
};

/** The file's language as a person says it ("TypeScript"); empty when the extension says nothing. */
export function languageName(path: string): string {
  const id = languageOfPath(path);
  return id ? (LANGUAGE[id] ?? "") : "";
}

const ICON: Record<ProblemSeverity, { icon: typeof CircleX; className: string; label: string }> = {
  error: { icon: CircleX, className: "text-err", label: "Error" },
  warning: { icon: CircleAlert, className: "text-warn", label: "Warning" },
  info: { icon: Info, className: "text-fg-3", label: "Info" },
  hint: { icon: Info, className: "text-fg-3", label: "Hint" },
};

/**
 * The file bar's status when a language server serves the file: a problems count (opens a compact list; a row jumps to
 * its line) and the server's state as a glyph of the app's family (polish step 4, E1) with its name, and its state in
 * words when it is not ready ("failed" in `err`, then Retry). Quiet meta text; no state for the first 200ms of
 * starting (no flash). `compact` (a narrow bar) drops the name but keeps the words of a state that is not ready; a
 * ready server is then its glyph alone in a 28px box, the name in the tooltip.
 */
export function EditorStatus({
  intel,
  fileKey,
  onJump,
  compact = false,
  hideReady = false,
}: {
  intel: EditorIntel;
  fileKey: FileKey;
  onJump(problem: Problem): void;
  /** Narrow row: the server as its glyph, its name in the tooltip. */ compact?: boolean;
  /** A very narrow row: a ready server shows nothing (screen readers still hear it); a state that is not ready still shows. */
  hideReady?: boolean;
}) {
  const info = useSyncExternalStore(intel.subscribe, () => intel.get(fileKey));
  const { status, problems, notice } = info;
  const starting = useDelayedLoading(status?.state === "starting");
  if (!status && !notice) return null;
  const shownState = status?.state === "starting" && !starting ? null : status?.state;
  const broken = status?.state === "failed" || status?.state === "stopped";
  // "TypeScript help failed" reads as the helper failing, never the file (a bare "Failed" beside the name did).
  const language = languageName(splitKey(fileKey).path);
  const help = language ? `${language} help` : "Language help";

  return (
    <>
      {notice && (
        <span role="status" title={notice} className="min-w-0 truncate text-fg-3">
          {notice}
        </span>
      )}
      {problems.length > 0 && <ProblemsButton problems={problems} onJump={onJump} />}
      {status && (
        <span
          role="status"
          aria-label={`${help} (language server ${status.label}): ${STATE_TEXT[status.state]}`}
          title={
            status.error
              ? `${help} ${STATE_TEXT[status.state]}. ${status.label}: ${status.error}`
              : `${help} is ${STATE_TEXT[status.state]} (language server ${status.label})`
          }
          data-lsp-state={status.state}
          className={
            hideReady && shownState !== "starting" && !broken
              ? "sr-only"
              : cn(
                  "flex h-7 min-w-0 shrink items-center gap-1.5",
                  broken && hideReady && "shrink-0",
                  compact && shownState === "ready" ? "w-7 shrink-0 justify-center" : "px-1",
                )
          }
        >
          {shownState && <StateGlyph state={GLYPH[shownState]} />}
          <span aria-hidden className={cn("max-w-[200px] min-w-0 truncate", compact && shownState === "ready" && "hidden")}>
            {broken ? (
              <span className="text-err">
                <span className="sm:hidden">Help</span>
                <span className="max-sm:hidden">{help}</span> {STATE_TEXT[status.state]}
              </span>
            ) : (
              <>
                {!compact && status.label}
                {shownState === "starting" && ` ${STATE_TEXT.starting}`}
              </>
            )}
          </span>
        </span>
      )}
      {status && broken && (
        <span aria-hidden className="shrink-0">
          ·
        </span>
      )}
      {status && broken && (
        <Button variant="quiet" size="sm" className="shrink-0 text-xs" onClick={() => intel.retry(fileKey)}>
          Retry
        </Button>
      )}
    </>
  );
}

function count(problems: Problem[], severity: ProblemSeverity): number {
  return problems.filter((p) => p.severity === severity).length;
}

function ProblemsButton({ problems, onJump }: { problems: Problem[]; onJump(problem: Problem): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const errors = count(problems, "error");
  const top = errors ? ICON.error : count(problems, "warning") ? ICON.warning : ICON.info;
  const Icon = top.icon;
  const n = problems.length;
  const sorted = [...problems].sort((a, b) => a.line - b.line || a.column - b.column);
  return (
    <>
      <Button
        ref={anchor}
        variant="quiet"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((x) => !x)}
        className={cn("shrink-0 text-xs tabular-nums", open && "bg-active text-fg")}
      >
        <Glyph icon={Icon} size={14} className={top.className} />
        {n}&nbsp;{n === 1 ? "problem" : "problems"}
      </Button>
      <Presence show={open}>
        <Popover anchor={anchor} label="Problems in this file" align="end" onClose={() => setOpen(false)} className="w-[min(420px,calc(100vw-16px))]">
          <ul className="overflow-y-auto overscroll-contain p-1">
            {sorted.map((p, i) => {
              const s = ICON[p.severity];
              const PIcon = s.icon;
              return (
                <li key={i}>
                  <ListRow
                    size="md"
                    tip={p.message}
                    leading={<Glyph icon={PIcon} size={14} className={s.className} />}
                    title={
                      <>
                        <span className="sr-only">{s.label}: </span>
                        {p.message}
                      </>
                    }
                    description={`${p.source ? `${p.source} · ` : ""}Ln ${p.line}, Col ${p.column}`}
                    onClick={() => {
                      setOpen(false);
                      onJump(p);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </Popover>
      </Presence>
    </>
  );
}
