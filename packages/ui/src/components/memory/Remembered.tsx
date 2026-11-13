import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { RememberKind } from "@octo/agent-client";
import { formatDay } from "../../lib/memory/dates";
import { fold, GROUP_FOLD, itemDescription, keeperName, needsFullFact, rememberedGroups, sourceText, type RememberedItem } from "../../lib/memory/tasks";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { IconMenu } from "../primitives/IconMenu";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { Segmented } from "../primitives/Segmented";
import { SectionHeader } from "../primitives/SectionHeader";
import { TextField } from "../primitives/TextField";
import { ConfirmDialog, Expansion, ROW_TAIL, RowLine, useCollapseOnEscape, useReveal } from "./parts";

export function RememberedHeader(props: { count: number; onAdd?: (() => void) | undefined }) {
  return (
    <SectionHeader
      inset
      aside={
        <>
          <span className="tabular-nums">{props.count}</span>
          {props.onAdd && (
            <Button variant="quiet" size="xs" icon={Plus} className="-mr-1" onClick={props.onAdd}>
              Add
            </Button>
          )}
        </>
      }
    >
      Remembered
    </SectionHeader>
  );
}

const KINDS: readonly { id: RememberKind; label: string }[] = [
  { id: "fact", label: "Fact" },
  { id: "decision", label: "Decision" },
  { id: "preference", label: "Preference" },
  { id: "todo", label: "To do" },
];

/** Writing an item yourself (`/remember`): one line, a kind, Enter to keep it. */
export function AddFact(props: { onDone(): void; onKept(): void }) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<RememberKind>("fact");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const keep = () => {
    const remember = bridge.rememberFact;
    if (!remember || busy || text.trim() === "") return;
    setBusy(true);
    setError(null);
    remember.call(bridge, projectId, { text: text.trim(), kind }).then(
      () => {
        props.onKept();
        props.onDone();
      },
      (e: unknown) => {
        setError(`${errorMessage(e)} Your text is still here; try again.`);
        setBusy(false);
      },
    );
  };
  return (
    <form
      aria-label="Remember something"
      className="flex flex-col gap-2 px-2 pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        keep();
      }}
    >
      <TextField
        id={id}
        aria-label="What should the project remember?"
        placeholder="What should the project remember?"
        value={text}
        size="sm"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the person pressed Add to type here
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onDone();
          }
        }}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <Segmented<RememberKind> label="Kind" options={KINDS} value={kind} onChange={setKind} />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="quiet" size="sm" onClick={props.onDone} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={text.trim() === ""}>
            Remember
          </Button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}

/**
 * The remembered items grouped by subject (decision 93 e): a quiet collapsible header per subject with its count, the
 * group touched most recently first; inside a group newest first, folded after five. One open row at a time overall.
 */
export function RememberedList(props: {
  items: RememberedItem[];
  now: number;
  /** `taskId/factId` to open and scroll to (a search hit); it may be an earlier version of an item. */
  focus: string | null;
  onOpenMessage?: ((id: number) => void) | undefined;
  onForgotten(): void;
}) {
  const groups = useMemo(() => rememberedGroups(props.items), [props.items]);
  const focused = useMemo(
    () => props.items.find((i) => i.key === props.focus || i.earlier.some((f) => `${i.taskId}/${f.id}` === props.focus)) ?? null,
    [props.items, props.focus],
  );
  const [open, setOpen] = useState<string | null>(focused?.key ?? null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const focusGroup = groups.find((g) => focused !== null && g.items.includes(focused));
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(
    focusGroup && focused && focusGroup.items.indexOf(focused) >= GROUP_FOLD ? new Set([focusGroup.key]) : new Set(),
  );
  const flip = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  return (
    <div className="flex flex-col">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        const { shown, hidden } = fold(g.items, unfolded.has(g.key), GROUP_FOLD);
        return (
          <section key={g.key} aria-label={g.subject} className="flex flex-col">
            <ListRow
              size="sm"
              tone="quiet"
              leading={<Glyph icon={isCollapsed ? ChevronRight : ChevronDown} size={14} />}
              title={g.subject}
              meta={g.items.length}
              expanded={!isCollapsed}
              onClick={() => setCollapsed((c) => flip(c, g.key))}
              trailing={ROW_TAIL}
            />
            {!isCollapsed && (
              <>
                <ul aria-label={g.subject} className="flex flex-col pl-6">
                  {shown.map((item) => (
                    <RememberedRow
                      key={item.key}
                      item={item}
                      now={props.now}
                      open={open === item.key}
                      reveal={item === focused}
                      earlierFirst={item === focused && item.key !== props.focus}
                      onToggle={() => setOpen((cur) => (cur === item.key ? null : item.key))}
                      onClose={() => setOpen(null)}
                      onOpenMessage={props.onOpenMessage}
                      onForgotten={props.onForgotten}
                    />
                  ))}
                </ul>
                {hidden > 0 && <ListRow size="sm" tone="quiet" title={`Show ${hidden} more`} onClick={() => setUnfolded((u) => flip(u, g.key))} />}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RememberedRow(props: {
  item: RememberedItem;
  now: number;
  open: boolean;
  reveal: boolean;
  earlierFirst: boolean;
  onToggle(): void;
  onClose(): void;
  onOpenMessage?: ((id: number) => void) | undefined;
  onForgotten(): void;
}) {
  const { item, now } = props;
  const { fact } = item;
  const { bridge } = useApp();
  const { projectId, state } = useProject();
  const { box, onKeyDown } = useCollapseOnEscape(props.open, props.onClose);
  const [earlier, setEarlier] = useState(props.earlierFirst);
  const [confirm, setConfirm] = useState(false);
  useReveal(box, props.reveal);
  const forget = bridge.forgetFact;
  const keeper = keeperName(fact.remembered_by, (id) => {
    const a = state.agents[id];
    return a ? (a.parent_id === null ? "Orchestrator" : a.title || a.role) : null;
  });
  const open = props.onOpenMessage;
  const line2 = itemDescription(item);
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the open row from anywhere inside it
    <li ref={box} onKeyDown={onKeyDown} className={cn(props.open && "mb-1 rounded-sm bg-active")}>
      <ListRow
        size="md"
        expanded={props.open}
        title={fact.text}
        {...(line2 === "" ? { meta: formatDay(fact.date, now) } : {})}
        {...(line2 === "" ? {} : { description: <RowLine end={formatDay(fact.date, now)}>{line2}</RowLine> })}
        tip={fact.text}
        onClick={props.onToggle}
        trailing={forget && <IconMenu label="Item actions" size="xs" items={[{ id: "forget", label: "Forget", run: () => setConfirm(true) }]} />}
      />
      {props.open && (
        <Expansion>
          {needsFullFact(fact.text) && <p className="text-sm break-words whitespace-pre-wrap text-fg">{fact.text}</p>}
          <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-fg-3">
            {open && fact.message_id > 0 ? (
              <Button variant="link" size="xs" tone="quiet" onClick={() => open(fact.message_id)}>
                {sourceText(fact, keeper, now)}
              </Button>
            ) : (
              sourceText(fact, keeper, now)
            )}
          </p>
          <p className="text-xs break-words text-fg-3">In task “{item.taskTitle}”</p>
          {item.earlier.length > 0 && (
            <div className="flex flex-col gap-1">
              <Button variant="quiet" size="xs" className="-ml-2 self-start" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>
                {earlier ? "Hide earlier versions" : `Show ${item.earlier.length} earlier ${item.earlier.length === 1 ? "version" : "versions"}`}
              </Button>
              {earlier && (
                <ul className="flex flex-col gap-1">
                  {item.earlier.map((f) => (
                    <li key={f.id} className="flex min-w-0 gap-2 text-sm text-fg-3">
                      <span className="min-w-0 flex-1 break-words">{f.text}</span>
                      <span className="shrink-0 text-xs">{formatDay(f.date, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Expansion>
      )}
      {confirm && forget && (
        <ConfirmDialog
          title="Forget this?"
          description="It is deleted from the project's memory and from search. The conversation is not changed. This cannot be undone."
          confirm="Forget"
          busyText="Forgetting"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await forget.call(bridge, projectId, item.taskId, fact.id);
            props.onForgotten();
          }}
        />
      )}
    </li>
  );
}
