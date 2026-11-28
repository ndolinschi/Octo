import { MousePointerClick } from "lucide-react";
import { memo } from "react";
import { browserHostLabel, elementSummary, type SentDesignNote } from "../../lib/browser/designNotes";
import { useOptionalCode } from "../../state/code";
import { useHost } from "../../state/host";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";

function resolveSourceFile(raw: string, folderLabels: readonly string[]): { folder?: string; path: string; line?: number } {
  const match = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(raw.trim());
  const clean = (match?.[1] ?? raw).replace(/^\/+/, "");
  const linePart = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
  const lineOpt = linePart !== undefined && Number.isFinite(linePart) ? { line: linePart } : {};
  const slash = clean.indexOf("/");
  if (slash > 0) {
    const head = clean.slice(0, slash);
    if (folderLabels.includes(head)) {
      return { folder: head, path: clean.slice(slash + 1), ...lineOpt };
    }
  }
  const fallback = folderLabels[0];
  return { ...(fallback ? { folder: fallback } : {}), path: clean, ...lineOpt };
}

/**
 * Browser Design Mode notes sent with a user prompt, rendered inside `[data-bubble][data-has-cards]` with the same
 * recessed-card + bubble-surface comment structure as `SentComments` (C3: `bg-panel`, never a coloured border).
 */
export const SentDesignNotes = memo(function SentDesignNotes({ notes }: { notes: SentDesignNote[] }) {
  return (
    <ul data-sent-design-notes className="flex flex-col gap-3">
      {notes.map((n, i) => (
        <DesignNoteCard key={`${n.url}:${i}`} note={n} />
      ))}
    </ul>
  );
});

const DesignNoteCard = memo(function DesignNoteCard({ note: n }: { note: SentDesignNote }) {
  const code = useOptionalCode();
  const { openFile } = useHost();
  const { elements, cssEdits } = n;
  const target =
    elements.length > 0 ? elements.map(elementSummary).join(", ") : n.area ? `Area ${Math.round(n.area.width)}×${Math.round(n.area.height)}` : "Page selection";
  const rawFile = elements.find((el) => el.component?.file)?.component?.file;
  const folderLabels = code ? code.folders.map((f) => f.label) : [];
  const parsed = rawFile ? resolveSourceFile(rawFile, folderLabels) : null;
  const displayPath = parsed ? parsed.path : null;
  const canOpen = Boolean(parsed && (openFile ?? parsed.folder));
  const hasSpecs = Boolean(n.textEdit) || cssEdits.length > 0 || (n.markupCount !== undefined && n.markupCount > 0);

  const openSource = () => {
    if (!parsed) return;
    if (openFile) {
      openFile(parsed.path, parsed.folder);
      return;
    }
    if (parsed.folder) {
      code?.openFile(parsed.folder, parsed.path, parsed.line ? { line: parsed.line } : undefined);
    }
  };

  return (
    <li className="flex flex-col">
      <div className="overflow-hidden rounded-md bg-panel">
        <div className="flex min-h-ctl-sm flex-wrap items-center gap-2 px-3 py-1 text-xs">
          <Glyph icon={MousePointerClick} size={14} className="shrink-0 text-fg-3" />
          <span className="shrink-0 text-fg-3">{browserHostLabel(n.url)}</span>
          <span className="min-w-0 truncate font-mono text-fg">{target}</span>
          {displayPath &&
            (canOpen ? (
              <Button variant="link" tone="quiet" mono size="xs" onClick={openSource} title={rawFile} className="ml-auto max-w-full min-w-0">
                <span className="truncate">{displayPath}</span>
              </Button>
            ) : (
              <span className="ml-auto min-w-0 truncate font-mono text-fg-3" title={rawFile}>
                {displayPath}
              </span>
            ))}
        </div>
        {hasSpecs && (
          <div className="border-t border-line bg-code-bg px-3 py-2 font-mono text-xs leading-5 text-fg-2">
            {n.textEdit && (
              <div className="truncate">
                <span className="text-fg-3">text: </span>
                <span>"{n.textEdit.before}"</span>
                <span className="text-fg-3"> → </span>
                <span className="text-fg">"{n.textEdit.after}"</span>
              </div>
            )}
            {cssEdits.map((c, idx) => (
              <div key={`${c.property}-${idx}`} className="truncate">
                <span className="text-fg-3">{c.property}: </span>
                <span>{c.before || "initial"}</span>
                <span className="text-fg-3"> → </span>
                <span className="text-fg">{c.after}</span>
              </div>
            ))}
            {n.markupCount !== undefined && n.markupCount > 0 && (
              <div className="text-fg-3">
                {n.markupCount} markup {n.markupCount === 1 ? "annotation" : "annotations"} on screenshot
              </div>
            )}
          </div>
        )}
      </div>
      {n.text && <p className="px-2 pt-2 pb-1 wrap-anywhere whitespace-pre-wrap text-fg">{n.text}</p>}
    </li>
  );
});
