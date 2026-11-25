import { Check, Undo2 } from "lucide-react";
import { memo } from "react";
import type { FileChangeSummary, TurnChanges } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { filesChanged, kindLabel, kindLetter, rowKey, sourceLabel, splitPath } from "../../lib/v7/changes";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";
import { Spinner } from "../primitives/Status";
import { LineCounts } from "./parts";
import type { RowState } from "./useChanges";

const KIND_TONE = { A: "text-ok", M: "text-fg-3", D: "text-err" } as const;

/**
 * One turn's changed files (v7 §1): a caption (`SectionHeader`, as every other list's group head) with the totals and
 * "Revert turn", then one 32px `ListRow` per file — kind letter, name, muted folder path, source, `+a −r`. The selected
 * row is `aria-current`.
 */
export const TurnFiles = memo(function TurnFiles(props: {
  turn: TurnChanges;
  label: string;
  selectedKey: string | null;
  rows: Readonly<Record<string, RowState>>;
  kept?: ReadonlySet<string>;
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
      <SectionHeader
        as="h3"
        inset
        aside={
          <>
            <span className="shrink-0 @max-xs/list:hidden">{filesChanged(turn.files.length)}</span>
            <LineCounts added={turn.added} removed={turn.removed} className="ml-auto" />
            {props.reverting ? (
              <span className="grid size-6 place-items-center" aria-label="Reverting">
                <Spinner />
              </span>
            ) : (
              <IconButton
                icon={Undo2}
                size="xs"
                label="Revert all changes from this request"
                disabled={allReverted}
                onClick={props.onRevertTurn}
                className="max-md:size-10"
              />
            )}
          </>
        }
      >
        <span title={props.label}>{props.label}</span>
      </SectionHeader>
      <ul className="flex flex-col">
        {turn.files.map((f) => {
          const key = rowKey(turn.turn_id, f);
          return (
            <li key={key}>
              <FileRow
                file={f}
                selected={props.selectedKey === key}
                kept={props.kept?.has(key) === true}
                state={props.rows[key]}
                onClick={() => props.onSelect(f)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
});

const FileRow = memo(function FileRow({
  file,
  selected,
  kept,
  state,
  onClick,
}: {
  file: FileChangeSummary;
  selected: boolean;
  kept: boolean;
  state: RowState | undefined;
  onClick(): void;
}) {
  const { dir, name } = splitPath(file.path);
  const letter = kindLetter(file.kind);
  const reverted = state !== undefined && "reverted" in state;
  const problem = state !== undefined && "problem" in state;
  return (
    <ListRow
      size="md"
      selected={selected}
      tip={`${kindLabel(file.kind)} by ${sourceLabel(file.source)}: ${file.folder}/${file.path}${reverted ? " (reverted)" : kept ? " (kept)" : ""}`}
      onClick={onClick}
      leading={
        kept && !reverted ? (
          <Glyph icon={Check} size={14} className="text-ok" />
        ) : (
          // 7e: a span's aria-label is ignored; the letter is hidden and its word read instead.
          <span className={cn("font-mono text-xs font-medium", KIND_TONE[letter])}>
            <span aria-hidden>{letter}</span>
            <span className="sr-only">{kindLabel(file.kind)}</span>
          </span>
        )
      }
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn("shrink-0 truncate", reverted && "text-fg-3 line-through", !reverted && kept && "text-fg-2")}>{name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
            <bdi>{dir}</bdi>
          </span>
        </span>
      }
      meta={
        reverted ? (
          "reverted"
        ) : problem ? (
          <span className="text-err">not reverted</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="@max-2xs/list:hidden">{sourceLabel(file.source)}</span>
            <LineCounts added={file.added} removed={file.removed} />
          </span>
        )
      }
    />
  );
});
