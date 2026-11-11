import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "../primitives/Glyph";
import { Highlight } from "../primitives/Highlight";
import { Popover } from "../primitives/Popover";
import { opensLevel, parseModelRef, pickerRows, type PickerData, type PickerRow } from "./modelPicker";

/** Rows visible before the list scrolls (28px each). */
const VISIBLE = 9;
const ROW = 28;

/**
 * The model picker (decisions 27, 53, 56, 58): a 320px popover attached to its chip, opening upward. Top level: the
 * models that can run, then the agents; an agent with several models has "›" (→ or click opens its models, its
 * default first; ← goes back). Search filters both levels at once. One name per row; the raw id is the tooltip.
 */
export function ModelPicker(props: {
  anchor: RefObject<HTMLElement | null>;
  data: PickerData;
  loading: boolean;
  value: string;
  onChoose(value: string): void;
  onClose(): void;
}) {
  const { data, value } = props;
  const current = parseModelRef(value);
  const [query, setQuery] = useState("");
  const [inside, setInside] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => pickerRows(data, query, inside), [data, query, inside]);
  const at = rows.length ? Math.min(selected, rows.length - 1) : -1;
  const agent = inside ? data.agents.find((a) => a.id === inside) : undefined;
  const optionId = (i: number) => `${listId}-o${i}`;

  const enabled = (r: PickerRow) => r.kind !== "agent" || r.agent.ready;
  const choose = (r: PickerRow | undefined) => {
    if (!r || !enabled(r)) return;
    if (r.kind === "agent" && opensLevel(r.agent) && !query) return open(r.agent.id);
    props.onChoose(r.kind === "model" ? r.model.value : r.kind === "agent" ? r.agent.value : r.model.value);
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
    // Back on the agent row it came from.
    setSelected(
      Math.max(
        0,
        pickerRows(data, "", null).findIndex((r) => r.kind === "agent" && r.agent.id === from),
      ),
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    const row = at >= 0 ? rows[at] : undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setSelected((at + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(row);
    } else if (e.key === "ArrowRight" && row?.kind === "agent" && opensLevel(row.agent) && e.currentTarget.selectionStart === query.length) {
      e.preventDefault();
      open(row.agent.id);
    } else if ((e.key === "ArrowLeft" || (e.key === "Backspace" && !query)) && inside && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      back();
    }
  };

  const isCurrent = (r: PickerRow) =>
    r.kind === "model"
      ? current.kind === "api" && current.model === r.model.value
      : r.kind === "agent"
        ? current.kind === "acp" && current.agent === r.agent.id && (current.model === null || !opensLevel(r.agent))
        : current.kind === "acp" && current.agent === r.agent.id && (current.model ?? r.agent.models.find((m) => m.isDefault)?.id) === r.model.id;
  const agentChosen = (id: string) => current.kind === "acp" && current.agent === id;

  const groupOf = (r: PickerRow | undefined) => (r === undefined ? undefined : r.kind === "model" ? "Models" : agent ? null : "Agents");
  return (
    <Popover anchor={props.anchor} label="Choose a model" side="top" gap={4} onClose={props.onClose} className="w-[min(320px,calc(100vw-16px))]">
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
          placeholder={agent ? `Search ${agent.label} models` : "Search models and agents"}
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
        {rows.map((r, i) => {
          const group = groupOf(r);
          const heading = group && group !== groupOf(rows[i - 1]);
          const ready = enabled(r);
          const label = r.kind === "model" ? r.model.label : r.kind === "agent" ? r.agent.label : agent ? r.model.label : `${r.agent.label} · ${r.model.label}`;
          const title = r.kind === "agent" ? (r.agent.hint ?? r.agent.value) : r.kind === "model" ? r.model.id : r.model.id;
          const checked = isCurrent(r);
          return (
            <div key={r.key}>
              {heading && <div className="flex h-row items-center px-2 text-xs text-fg-3">{group}</div>}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={i === at}
                aria-disabled={!ready || undefined}
                title={title}
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => i !== at && setSelected(i)}
                onClick={() => choose(r)}
                className={cn("flex h-row items-center gap-2 rounded-sm px-2", ready ? "press-row" : "cursor-default", i === at && ready && "bg-active")}
              >
                <span className="grid size-4 shrink-0 place-items-center text-fg">{checked && <Glyph icon={Check} size={14} />}</span>
                <span className={cn("min-w-0 truncate", ready ? "text-fg" : "text-fg-3")}>
                  <Highlight text={label} query={query} />
                </span>
                {r.kind === "agent-model" && r.model.isDefault && <span className="shrink-0 text-xs text-fg-3">default</span>}
                {r.kind === "agent" && !ready && <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-3">{r.agent.hint}</span>}
                {r.kind === "agent" && ready && agentChosen(r.agent.id) && !checked && current.kind === "acp" && current.model && (
                  <span className="ml-auto min-w-0 truncate text-xs text-fg-3">{r.agent.models.find((m) => m.id === current.model)?.label}</span>
                )}
                {r.kind === "agent" && opensLevel(r.agent) && !query && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${r.agent.label} models`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open(r.agent.id);
                    }}
                    className={cn("-mr-1 grid size-6 shrink-0 place-items-center rounded-xs text-fg-3 hover:text-fg", !agentChosen(r.agent.id) && "ml-auto")}
                  >
                    <Glyph icon={ChevronRight} size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <p className="flex h-row items-center px-2 text-xs text-fg-3">
            {props.loading ? "Loading agents…" : query ? "Nothing matches" : "Nothing can run yet. Connect a provider in Settings."}
          </p>
        )}
        {props.loading && rows.length > 0 && !inside && <p className="flex h-row items-center px-2 text-xs text-fg-3">Loading agents…</p>}
      </div>
    </Popover>
  );
}
