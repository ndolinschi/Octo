import { Undo2 } from "lucide-react";
import type { FileChangeSummary, TurnChanges } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { filesChanged, kindLabel, kindLetter, rowKey, sourceLabel, splitPath } from "../../lib/v7/changes";
import { IconButton } from "../primitives/Button";
import { Spinner } from "../primitives/Status";
import { LineCounts } from "./parts";
import type { RowState } from "./useChanges";

const KIND_TONE = { A: "text-ok", M: "text-fg-3", D: "text-err" } as const;

/**
 * One turn's changed files (v7 §1): a caption with the totals and "Revert turn", then one 28px row per file — kind
 * letter, name, muted folder path, source, `+a −r`. Rows are buttons; the selected one is `aria-current`.
 */
export function TurnFiles(props: {
  turn: TurnChanges;
  label: string;
  selectedKey: string | null;
  rows: Readonly<Record<string, RowState>>;
  reverting: boolean;
  onSelect(file: FileChangeSummary): void;
  onRevertTurn(): void;
}) {
  const { turn } = props;
  const allReverted = turn.files.every((f) => {
    const r = props.rows[rowKey(turn.turn_id, f)];
    return r !== undefined && "reverted" in r;
  });
  return (
    <section aria-label={`${props.label}: ${filesChanged(turn.files.length)}`} className="flex flex-col">
      <header className="flex h-8 min-w-0 items-center gap-2 pr-1 pl-2">
        <span className="min-w-0 truncate text-sm text-fg-2" title={props.label}>
          {props.label}
        </span>
        <span className="shrink-0 text-xs text-fg-3 @max-xs/list:hidden">{filesChanged(turn.files.length)}</span>
        <LineCounts added={turn.added} removed={turn.removed} className="ml-auto" />
        {props.reverting ? (
          <span className="grid size-6 place-items-center" aria-label="Reverting">
            <Spinner />
          </span>
        ) : (
          <IconButton icon={Undo2} size="sm" label="Revert this turn" disabled={allReverted} onClick={props.onRevertTurn} className="max-md:size-10" />
        )}
      </header>
      <ul className="flex flex-col">
        {turn.files.map((f) => {
          const key = rowKey(turn.turn_id, f);
          return (
            <li key={key}>
              <FileRow file={f} selected={props.selectedKey === key} state={props.rows[key]} onClick={() => props.onSelect(f)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FileRow({ file, selected, state, onClick }: { file: FileChangeSummary; selected: boolean; state: RowState | undefined; onClick(): void }) {
  const { dir, name } = splitPath(file.path);
  const letter = kindLetter(file.kind);
  const reverted = state !== undefined && "reverted" in state;
  const problem = state !== undefined && "problem" in state;
  return (
    <button
      type="button"
      data-row
      aria-current={selected ? "true" : undefined}
      title={`${kindLabel(file.kind)} by ${sourceLabel(file.source)}: ${file.folder}/${file.path}${reverted ? " (reverted)" : ""}`}
      onClick={onClick}
      className={cn(
        "flex h-ctl-md w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm press-row focus-inset max-md:h-ctl-lg touch:h-ctl-lg",
        selected ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      <span aria-label={kindLabel(file.kind)} className={cn("w-4 shrink-0 text-center font-mono text-xs font-medium", KIND_TONE[letter])}>
        {letter}
      </span>
      <span className={cn("shrink-0 truncate", reverted && "text-fg-3 line-through")}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
        <bdi>{dir}</bdi>
      </span>
      {reverted ? (
        <span className="shrink-0 text-xs text-fg-3">reverted</span>
      ) : problem ? (
        <span className="shrink-0 text-xs text-err">not reverted</span>
      ) : (
        <>
          <span className="shrink-0 text-xs text-fg-3 @max-2xs/list:hidden">{sourceLabel(file.source)}</span>
          <LineCounts added={file.added} removed={file.removed} />
        </>
      )}
    </button>
  );
}
