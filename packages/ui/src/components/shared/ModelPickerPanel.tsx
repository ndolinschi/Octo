import { Check, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { Fragment, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { parseAcp } from "../../lib/models";
import {
  EXPERIMENTAL_TIP,
  USE_ANYWAY_NOTE,
  cleanModelName,
  emptyListNote,
  pickerKey,
  pickerRows,
  pickerView,
  recheckAgent,
  useModelPicker,
  type PickerRow,
} from "../../lib/providers";
import { useApp } from "../../state/app";
import { useShell } from "../../state/shell";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { SearchField } from "../primitives/SearchField";
import { TextField } from "../primitives/TextField";
import { ProviderMark } from "../primitives/ProviderMark";
import { Highlight } from "../primitives/Highlight";
import { Popover } from "../primitives/Popover";
import type { ModelPickerProps } from "./modelPickerProps";

/** Rows visible before the list scrolls (28px each). */
const VISIBLE = 9;
const ROW = 28;
const STALE_NOTE = "not offered in the last session";

/** A model typed by hand: at the top level (project settings) a model id of any provider, in an agent's list a name for that agent. */
type Custom = { kind: "custom"; key: string; value: string; label: string; agentId: string | null };

/**
 * The model picker's list (decisions 53, 56, 58), loaded with the first open: a 320px popover attached to its chip. It renders
 * `useModelPicker`'s view and never decides what can run. Top level: the models of the API and the router, then one flat
 * row per ready agent (its chosen model dim on the right; every agent opens a second level with "›", → or a click), then,
 * below a "Not connected" divider, one row per provider that is not ready, which opens its connect sheet and is never
 * selectable. Second level: "Default (the agent decides)", the models it knows (stale ones dim), "Other model…" (a field:
 * type a name, Enter), and "Refresh models" in the header. One name per row; the raw id is the tooltip.
 */
export function ModelPickerPanel(props: ModelPickerProps & { anchor: RefObject<HTMLButtonElement | null>; side: "top" | "bottom"; onClose(): void }) {
  const { bridge } = useApp();
  const { openConnect } = useShell();
  const current = parseAcp(props.value);
  const [query, setQuery] = useState(props.openRequest?.query ?? "");
  const [inside, setInside] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  /** The agent whose "Check again" runs, and the one that was checked and still reads as logged out. */
  const [checking, setChecking] = useState<string | null>(null);
  const [stillOut, setStillOut] = useState<string | null>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const other = useRef<HTMLInputElement>(null);
  const { load, view, refresh, refreshModels, addModel, removeModel, refreshing } = useModelPicker(bridge, { query, agent: inside, current: props.value });
  const top = useMemo(() => (load.status === "ready" || load.status === "error" ? (load.list ? pickerView(load.list, { query: "" }) : null) : null), [load]);
  const typed = query.trim();
  const rows = view ? pickerRows(view) : [];
  const agent = view?.level === "agent" ? view.agent : null;
  const single = typed !== "" && !/\s/.test(typed);
  const taken = rows.some((r) => r.kind !== "connect" && r.kind !== "other" && r.value.replace(/^acp:[^/]*\//, "") === typed);
  const custom: Custom | null =
    !single || taken || (agent && !agent.acceptsCustom)
      ? null
      : agent
        ? { kind: "custom", key: `custom:${typed}`, value: `acp:${agent.id}/${typed}`, label: typed, agentId: agent.id }
        : props.custom && inside === null
          ? { kind: "custom", key: `custom:${typed}`, value: typed, label: typed, agentId: null }
          : null;
  const entries: (PickerRow | Custom)[] = custom ? [custom, ...rows] : rows;
  const at = entries.length ? Math.min(selected, entries.length - 1) : -1;
  const optionId = (i: number) => `${listId}-o${i}`;

  const choose = (value: string, name?: { agent: string; model: string }) => {
    if (name) addModel(name.agent, name.model);
    props.onChoose(value);
    props.onClose();
  };
  const pickAnyway = (providerId: string) => {
    props.onChooseUnverified?.(`acp:${providerId}`);
    props.onClose();
  };
  const checkAgain = async (providerId: string) => {
    if (checking) return;
    setChecking(providerId);
    setStillOut(null);
    try {
      if (!(await recheckAgent(bridge, providerId))) setStillOut(providerId);
    } catch {
      // The row keeps its state; "Check again" can be pressed once more and the connect sheet shows the harness's own reason.
      setStillOut(providerId);
    } finally {
      setChecking(null);
    }
  };
  const act = (r: PickerRow | Custom | undefined) => {
    if (!r) return;
    if (r.kind === "connect" && r.unsupported) return;
    if (r.kind === "connect") {
      props.onClose();
      const id = r.providerId;
      const anyway = r.unverified && props.onChooseUnverified ? () => props.onChooseUnverified?.(`acp:${id}`) : undefined;
      openConnect(id, anyway);
      return;
    }
    if (r.kind === "agent") return open(r.providerId);
    if (r.kind === "other") return startTyping();
    if (r.kind === "custom") return r.agentId ? choose(r.value, { agent: r.agentId, model: r.value.slice(`acp:${r.agentId}/`.length) }) : choose(r.value);
    choose(r.value);
  };
  const open = (id: string) => {
    setInside(id);
    setQuery("");
    setSelected(0);
    setTyping(false);
    setRefreshNote(null);
    input.current?.focus();
  };
  const back = () => {
    const from = inside;
    setInside(null);
    setQuery("");
    setTyping(false);
    setRefreshNote(null);
    const index = top ? pickerRows(top).findIndex((r) => r.kind === "agent" && r.providerId === from) : -1;
    setSelected(Math.max(0, index));
    input.current?.focus();
  };
  const startTyping = () => {
    setTyping(true);
    setDraft("");
    requestAnimationFrame(() => other.current?.focus());
  };
  const commitTyped = () => {
    const name = cleanModelName(draft);
    if (!agent || !name) return;
    choose(`acp:${agent.id}/${name}`, { agent: agent.id, model: name });
  };
  const doRefresh = async () => {
    if (!agent || refreshing) return;
    setRefreshNote(null);
    const note = await refreshModels(agent.id);
    setRefreshNote(note);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = entries.length;
    const row = at >= 0 ? entries[at] : undefined;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
      e.preventDefault();
      setSelected((at + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      act(row);
      return;
    }
    // Text-caret keys belong to the field until the caret is at the edge the key moves towards.
    const atEnd = e.currentTarget.selectionStart === query.length;
    const atStart = e.currentTarget.selectionStart === 0;
    if (e.key === "ArrowRight" && !atEnd) return;
    if (e.key === "ArrowLeft" && !atStart) return;
    if (e.key === "Backspace" && (query || !inside)) return;
    if (!view || row?.kind === "custom") return;
    const step = pickerKey(view, at - (custom ? 1 : 0), e.key === "Backspace" ? "ArrowLeft" : e.key, top ?? undefined);
    if (step?.do === "open") {
      e.preventDefault();
      open(step.agent);
    } else if (step?.do === "back") {
      e.preventDefault();
      back();
    }
  };

  const isCurrent = (r: PickerRow): boolean => {
    if (r.kind === "connect" || r.kind === "other") return false;
    if (!current) return r.kind !== "agent" && r.value === props.value;
    if (r.kind === "agent") return current.id === r.providerId;
    const ref = parseAcp(r.value);
    if (!ref) return false;
    return ref.id === current.id && ref.model === current.model;
  };

  const heading = (i: number): string | null => {
    const r = entries[i];
    if (!r || view?.level !== "top") return null;
    if (r.kind === "custom") return "Custom";
    const prev = entries[i - 1];
    if (r.kind === "connect") return prev?.kind === "connect" ? null : "Not set up";
    const group = view.groups.find((g) => g.rows.includes(r));
    const same = prev !== undefined && prev.kind !== "custom" && prev.kind !== "connect" && group?.rows.includes(prev);
    return same ? null : (group?.label ?? null);
  };

  const empty = !view
    ? load.status === "loading"
      ? "Loading providers…"
      : "The providers did not load."
    : entries.length === 0
      ? query
        ? "Nothing matches"
        : "Nothing can run yet. Connect a provider."
      : null;
  const activeRow = at >= 0 ? entries[at] : undefined;
  const unverifiedNote = activeRow?.kind === "connect" && activeRow.unverified && props.onChooseUnverified !== undefined;
  const why = agent ? emptyListNote({ ...agent, error: refreshNote ?? agent.error }, refreshing) : null;
  // An empty list explains itself in the dim line; a short list with a failed look keeps the warning.
  const error = agent && !why ? (refreshNote ?? agent.error) : "";
  return (
    <Popover
      anchor={props.anchor}
      label={`Choose ${props.label.toLowerCase()}`}
      side={props.side}
      gap={4}
      align={props.side === "bottom" ? "end" : "start"}
      onClose={props.onClose}
      className="w-[min(320px,calc(100vw-16px))]"
    >
      <SearchField
        ref={input}
        variant="header"
        clearOnEscape={false}
        label={agent ? `Search ${agent.label} models` : "Search models and agents"}
        placeholder={agent ? `Search ${agent.label} models` : props.custom ? "Search, or type a model id" : "Search models and agents"}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
        inputProps={{
          role: "combobox",
          "aria-expanded": true,
          "aria-controls": listId,
          ...(at >= 0 ? { "aria-activedescendant": optionId(at) } : {}),
        }}
      />
      {agent && (
        <div className="mx-1 mt-1 flex h-row shrink-0 items-center gap-1">
          <Button variant="quiet" size="xs" icon={ChevronLeft} onClick={back} className="min-w-0 flex-1 justify-start">
            <span className="truncate">{agent.label}</span>
          </Button>
          <Button
            variant="quiet"
            size="xs"
            icon={RefreshCw}
            loading={refreshing}
            onClick={() => void doRefresh()}
            title={
              agent.refreshedAt
                ? `Ask ${agent.label} which models it offers (last read ${new Date(agent.refreshedAt).toLocaleString()})`
                : `Ask ${agent.label} which models it offers`
            }
          >
            Refresh models
          </Button>
        </div>
      )}
      {why && (
        <p className="mx-1 shrink-0 px-2 pt-1 text-xs text-fg-3">
          {why.reason}
          {why.note && <span className="mt-0.5 line-clamp-2 block">{why.note}</span>}
        </p>
      )}
      {unverifiedNote && <p className="mx-1 shrink-0 px-2 pt-1 text-xs text-fg-3">{USE_ANYWAY_NOTE}</p>}
      {error && (
        <p role="alert" className="mx-1 shrink-0 px-2 pt-1 text-xs text-warn">
          {error}
        </p>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={agent ? `${agent.label} models` : "Models and agents"}
        className="overflow-y-auto overscroll-contain p-1"
        style={{ maxHeight: VISIBLE * ROW + 8 }}
      >
        {entries.map((r, i) => {
          const group = heading(i);
          const checked = r.kind !== "custom" && isCurrent(r);
          if (r.kind === "other" && typing)
            return (
              <div key={r.key} className="flex h-row items-center gap-2 rounded-sm bg-active px-2">
                <span className="size-4 shrink-0" />
                <TextField
                  ref={other}
                  variant="bare"
                  value={draft}
                  aria-label={`Model name for ${agent?.label ?? "the agent"}`}
                  placeholder={`e.g. ${agent?.example ?? "opus"}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTyped();
                    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      setTyping(false);
                      input.current?.focus();
                    }
                  }}
                />
              </div>
            );
          return (
            <Fragment key={r.key}>
              {group && <div className="flex h-row items-center px-2 text-xs text-fg-3">{group}</div>}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={i === at}
                title={rowTitle(r)}
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => i !== at && setSelected(i)}
                onClick={() => act(r)}
                className={cn("group flex h-row items-center gap-2 rounded-sm px-2 press-row", i === at && "bg-active")}
              >
                <span className="grid size-4 shrink-0 place-items-center text-fg">
                  {checked && r.kind !== "agent" && <Glyph icon={Check} size={14} />}
                  {r.kind === "connect" && <ProviderMark id={r.providerId} label={r.label} className="text-fg-3" />}
                  {r.kind === "agent" && <ProviderMark id={r.providerId} label={r.label} className="text-fg-3" />}
                </span>
                <RowBody row={r} query={query} />
                {r.kind === "connect" && r.unverified && (
                  <UnverifiedActions
                    checking={checking === r.providerId}
                    still={stillOut === r.providerId}
                    onCheck={() => void checkAgain(r.providerId)}
                    {...(props.onChooseUnverified ? { onUse: () => pickAnyway(r.providerId) } : {})}
                  />
                )}
                {r.kind === "agent" && <Glyph icon={ChevronRight} size={14} className="-mr-0.5 shrink-0 text-fg-3" />}
                {r.kind === "model" && r.removable && (
                  <IconButton
                    icon={X}
                    size="xs"
                    tabIndex={-1}
                    label={`Remove ${r.label}`}
                    title={`Remove ${r.label} from this list`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (inside) removeModel(inside, r.value.slice(`acp:${inside}/`.length));
                    }}
                    className="-mr-1 opacity-0 group-hover:opacity-100"
                  />
                )}
              </div>
            </Fragment>
          );
        })}
        {empty && (
          <div className="flex min-h-row items-center gap-2 px-2 text-xs text-fg-3">
            <span className="min-w-0 flex-1">{empty}</span>
            {!view && load.status === "error" && (
              <Button variant="quiet" size="xs" onClick={() => void refresh()}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
      {props.footer && !agent && <div className="shrink-0 border-t border-line px-3 py-1.5">{props.footer}</div>}
    </Popover>
  );
}

/** The dim word after an agent's label whose launch command has not been run with Octo. */
function Experimental() {
  return (
    <span className="shrink-0 text-xs text-fg-3" title={EXPERIMENTAL_TIP}>
      experimental
    </span>
  );
}

/** "Check again" and "Use anyway" on a not-logged-in agent's row; out of the tab order like the row's remove button (Enter opens the connect sheet with both). */
function UnverifiedActions({ checking, still, onCheck, onUse }: { checking: boolean; still: boolean; onCheck(): void; onUse?: () => void }) {
  const stop = (fn: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    fn();
  };
  return (
    <span className="flex shrink-0 items-center gap-1">
      {still && !checking && <span className="text-xs text-warn">Still logged out</span>}
      <Button variant="quiet" size="xs" tabIndex={-1} loading={checking} onClick={stop(onCheck)}>
        Check again
      </Button>
      {onUse && (
        <Button variant="quiet" size="xs" tabIndex={-1} onClick={stop(onUse)}>
          Use anyway
        </Button>
      )}
    </span>
  );
}

function rowTitle(r: PickerRow | Custom): string {
  if (r.kind === "custom") return r.agentId ? `Use “${r.label}” as the model name` : `Use “${r.value}” as the model id`;
  if (r.kind === "connect") return r.unsupported ? `${r.label}: ${r.reason ?? r.state}` : `${r.label}: ${r.state}`;
  if (r.kind === "other") return "Type the name of a model this agent accepts";
  if (r.kind === "agent") return `${r.label}: choose a model`;
  if (r.kind === "default") return "No model named: the agent uses its own default";
  const how =
    r.source === "custom"
      ? "added by you"
      : r.source === "advertised"
        ? "offered by the agent"
        : r.source === "command"
          ? "listed by the agent's command"
          : null;
  const note = r.stale ? STALE_NOTE : how;
  return note ? `${r.value} (${note})` : r.value;
}

/** The label and the quiet words after it. */
function RowBody({ row, query }: { row: PickerRow | Custom; query: string }) {
  if (row.kind === "custom")
    return (
      <>
        <span className="min-w-0 truncate text-fg">Use “{row.label}”</span>
        <span className="shrink-0 text-xs text-fg-3">{row.agentId ? "model name" : "model id"}</span>
      </>
    );
  if (row.kind === "connect")
    return (
      <>
        <span className="min-w-0 truncate text-fg-2">{row.label}</span>
        {row.experimental && <Experimental />}
        <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-3">
          {row.unsupported ? (row.reason ?? row.state) : row.unverified ? row.state : `${row.state} · ${row.action}`}
        </span>
      </>
    );
  if (row.kind === "other") return <span className="min-w-0 truncate text-fg-2">{row.label}</span>;
  if (row.kind === "agent" || row.kind === "default")
    return (
      <>
        <span className="min-w-0 truncate text-fg">
          <Highlight text={row.label} query={query} />
        </span>
        {row.kind === "agent" && row.experimental && <Experimental />}
        {row.detail && <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-3">{row.detail}</span>}
      </>
    );
  const label = row.agentLabel ? `${row.agentLabel} · ${row.label}` : row.label;
  return (
    <>
      <span className={cn("min-w-0 truncate", row.stale ? "text-fg-3" : "text-fg")}>
        <Highlight text={label} query={query} />
      </span>
      {row.isDefault && <span className="shrink-0 text-xs text-fg-3">default</span>}
      {row.stale && <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-3">{STALE_NOTE}</span>}
    </>
  );
}
