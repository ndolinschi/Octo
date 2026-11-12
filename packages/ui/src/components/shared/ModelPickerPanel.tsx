import { Check, ChevronLeft, ChevronRight, Plug, Search } from "lucide-react";
import { Fragment, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { parseAcp } from "../../lib/models";
import { pickerKey, pickerRows, pickerView, useModelPicker, type PickerRow, type PickerView } from "../../lib/providers";
import { useApp } from "../../state/app";
import { useShell } from "../../state/shell";
import { Glyph } from "../primitives/Glyph";
import { Highlight } from "../primitives/Highlight";
import { Popover } from "../primitives/Popover";
import type { ModelPickerProps } from "./modelPickerProps";

/** Rows visible before the list scrolls (28px each). */
const VISIBLE = 9;
const ROW = 28;
const STALE_NOTE = "not offered in the last session";

/** A model typed by hand (project settings), offered as the first row while the text is a single word no row already is. */
type Custom = { kind: "custom"; key: string; value: string };

/**
 * The model picker's list (decisions 53, 56, 58), loaded with the first open: a 320px popover attached to its chip. It renders
 * `useModelPicker`'s view and never decides what can run. Top level: the models of every connected provider grouped by
 * provider (an agent with several models has "›"; → or the chevron opens them, ← goes back), then one row per provider that
 * is not connected ("Connect", "How to connect", "Reconnect"), which opens its connect sheet. A model the agent no longer
 * advertises stays, dim, with a note. One name per row; the raw id is the tooltip.
 */
export function ModelPickerPanel(props: ModelPickerProps & { anchor: RefObject<HTMLButtonElement | null>; side: "top" | "bottom"; onClose(): void }) {
  const { bridge } = useApp();
  const { openConnect } = useShell();
  const current = parseAcp(props.value);
  const [query, setQuery] = useState("");
  const [inside, setInside] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { load, view, refresh } = useModelPicker(bridge, { query, agent: inside });
  const top = useMemo(() => (load.status === "ready" || load.status === "error" ? (load.list ? pickerView(load.list, { query: "" }) : null) : null), [load]);
  const typed = query.trim();
  const rows = view ? pickerRows(view) : [];
  const custom: Custom | null =
    props.custom && typed && !/\s/.test(typed) && inside === null && !rows.some((r) => r.kind !== "connect" && r.value === typed)
      ? { kind: "custom", key: `custom:${typed}`, value: typed }
      : null;
  const entries: (PickerRow | Custom)[] = custom ? [custom, ...rows] : rows;
  const at = entries.length ? Math.min(selected, entries.length - 1) : -1;
  const optionId = (i: number) => `${listId}-o${i}`;
  const agent = view?.level === "agent" ? view.agent : null;

  const act = (r: PickerRow | Custom | undefined) => {
    if (!r) return;
    if (r.kind === "connect") {
      props.onClose();
      openConnect(r.providerId);
      return;
    }
    props.onChoose(r.value);
    props.onClose();
  };
  const open = (id: string) => {
    setInside(id);
    setQuery("");
    setSelected(0);
    input.current?.focus();
  };
  const back = () => {
    const from = inside;
    setInside(null);
    setQuery("");
    const index = top ? pickerRows(top).findIndex((r) => r.kind === "agent" && r.providerId === from) : -1;
    setSelected(Math.max(0, index));
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
    if (!view || (row && row.kind === "custom")) return;
    const step = pickerKey(view, at - (custom ? 1 : 0), e.key === "Backspace" ? "ArrowLeft" : e.key, top ?? undefined);
    if (step?.do === "open") {
      e.preventDefault();
      open(step.agent);
    } else if (step?.do === "back") {
      e.preventDefault();
      back();
    }
  };

  const isCurrent = (r: PickerRow) => {
    if (r.kind === "connect" || !current) return r.kind !== "connect" && !current && r.value === props.value;
    if (r.kind === "agent") return current.id === r.providerId && (current.model === null || !r.hasModels);
    const ref = parseAcp(r.value);
    return ref !== null && ref.id === current.id && (current.model ?? agentDefault(view, r.providerId)) === ref.model;
  };

  const heading = (i: number): string | null => {
    const r = entries[i];
    if (!r || view?.level !== "top") return null;
    if (r.kind === "custom") return "Custom";
    const prev = entries[i - 1];
    if (r.kind === "connect") return prev?.kind === "connect" ? null : "Not connected";
    const group = view.groups.find((g) => g.providerId === r.providerId);
    const same = prev !== undefined && prev.kind !== "custom" && prev.kind !== "connect" && prev.providerId === r.providerId;
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
      <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-3">
        <Glyph icon={Search} size={14} className="shrink-0 text-fg-3" />
        <input
          ref={input}
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          aria-label={agent ? `Search ${agent.label} models` : "Search models and agents"}
          placeholder={agent ? `Search ${agent.label} models` : props.custom ? "Search, or type a model id" : "Search models and agents"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
        />
      </div>
      {agent && (
        <button
          type="button"
          onClick={back}
          className="mx-1 mt-1 flex h-row shrink-0 press items-center gap-1.5 rounded-sm px-2 text-left text-xs text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Glyph icon={ChevronLeft} size={14} />
          {agent.label}
        </button>
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
                className={cn("flex h-row items-center gap-2 rounded-sm px-2 press-row", i === at && "bg-active")}
              >
                <span className="grid size-4 shrink-0 place-items-center text-fg">
                  {checked && <Glyph icon={Check} size={14} />}
                  {r.kind === "connect" && <Glyph icon={Plug} size={14} className="text-fg-3" />}
                </span>
                <RowBody row={r} query={query} />
                {r.kind === "agent" && r.hasModels && !query && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${r.label} models`}
                    title={`${r.label} models`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open(r.providerId);
                    }}
                    className="-mr-1 ml-auto grid size-6 shrink-0 place-items-center rounded-xs text-fg-3 hover:text-fg"
                  >
                    <Glyph icon={ChevronRight} size={14} />
                  </button>
                )}
              </div>
            </Fragment>
          );
        })}
        {empty && (
          <div className="flex min-h-row items-center gap-2 px-2 text-xs text-fg-3">
            <span className="min-w-0 flex-1">{empty}</span>
            {!view && load.status === "error" && (
              <button type="button" onClick={() => void refresh()} className="shrink-0 rounded-xs px-1 text-fg-2 hover:text-fg">
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </Popover>
  );
}

function agentDefault(view: PickerView | null, agentId: string): string | undefined {
  if (!view) return undefined;
  const rows = pickerRows(view);
  const def = rows.find((r) => r.kind === "model" && r.isDefault && parseAcp(r.value)?.id === agentId);
  return def && def.kind === "model" ? (parseAcp(def.value)?.model ?? undefined) : undefined;
}

function rowTitle(r: PickerRow | Custom): string {
  if (r.kind === "custom") return `Use “${r.value}” as the model id`;
  if (r.kind === "connect") return `${r.label}: ${r.state}`;
  if (r.kind === "agent") return r.value;
  return r.stale ? `${r.value} (${STALE_NOTE})` : r.value;
}

/** The label and the quiet words after it. */
function RowBody({ row, query }: { row: PickerRow | Custom; query: string }) {
  if (row.kind === "custom")
    return (
      <>
        <span className="min-w-0 truncate text-fg">Use “{row.value}”</span>
        <span className="shrink-0 text-xs text-fg-3">model id</span>
      </>
    );
  if (row.kind === "connect")
    return (
      <>
        <span className="min-w-0 truncate text-fg-2">{row.label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-3">
          {row.state} · {row.action}
        </span>
      </>
    );
  if (row.kind === "agent")
    return (
      <>
        <span className="min-w-0 truncate text-fg">
          <Highlight text={row.label} query={query} />
        </span>
        {row.detail && <span className="min-w-0 truncate text-xs text-fg-3">{row.detail}</span>}
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
