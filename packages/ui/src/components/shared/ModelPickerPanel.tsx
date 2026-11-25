import { Check, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { parseAcp } from "../../lib/models";
import {
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
import { PopupList, popupOptionId } from "../primitives/PopupList";
import { popupMove } from "../primitives/popupNav";
import type { PickerSection } from "../../lib/picker";
import { Popover } from "../primitives/Popover";
import type { ModelPickerProps } from "./modelPickerProps";

const STALE_NOTE = "not offered last time";

/** A model typed by hand: at the top level (project settings) a model id of any provider, in an agent's list a name for that agent. */
type Custom = { kind: "custom"; key: string; value: string; label: string; agentId: string | null };

/** The folded "Not set up" group: one row that opens the rest in place (Settings → Providers' wording and behaviour). */
type More = { kind: "more"; key: string; label: string };

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
  const [unfolded, setUnfolded] = useState(false);
  const [draft, setDraft] = useState("");
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  /** The agent whose "Check again" runs, and the one that was checked and still reads as logged out. */
  const [checking, setChecking] = useState<string | null>(null);
  const [stillOut, setStillOut] = useState<string | null>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { load, view, refresh, refreshModels, addModel, removeModel, refreshing } = useModelPicker(bridge, { query, agent: inside, current: props.value });
  const top = useMemo(() => (load.status === "ready" || load.status === "error" ? (load.list ? pickerView(load.list, { query: "" }) : null) : null), [load]);
  const typed = query.trim();
  const providerKinds = new Map((load.status === "ready" || load.status === "error" ? (load.list?.providers ?? []) : []).map((p) => [p.id, p.kind]));
  const allRows = view ? pickerRows(view) : [];
  // Settings → Providers folds "Not set up" into "N more … can be added" once something is connected; a search shows every match.
  const loose = allRows.flatMap((r) => (r.kind === "connect" ? [r] : []));
  const fold = view?.level === "top" && !unfolded && typed === "" && loose.length > 0 && loose.length < allRows.length;
  const rows = fold ? allRows.filter((r) => r.kind !== "connect") : allRows;
  const more: More | null = fold
    ? {
        kind: "more",
        key: "more:connect",
        label: `${loose.length} more ${loose.every((r) => providerKinds.get(r.providerId) === "agent") ? "agent" : "provider"}${loose.length === 1 ? "" : "s"} can be added`,
      }
    : null;
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
  const entries: (PickerRow | Custom | More)[] = [...(custom ? [custom] : []), ...rows, ...(more ? [more] : [])];
  const at = entries.length ? Math.min(selected, entries.length - 1) : -1;
  const optionId = (i: number) => popupOptionId(listId, entries[i]?.key ?? "");

  const choose = (value: string, name?: { agent: string; model: string }) => {
    if (name) addModel(name.agent, name.model);
    props.onChoose(value);
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
  const act = (r: PickerRow | Custom | More | undefined) => {
    if (!r) return;
    if (r.kind === "more") return setUnfolded(true);
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
    refocus();
  };
  const back = () => {
    const from = inside;
    setInside(null);
    setQuery("");
    setTyping(false);
    setRefreshNote(null);
    const index = top ? pickerRows(top).findIndex((r) => r.kind === "agent" && r.providerId === from) : -1;
    setSelected(Math.max(0, index));
    refocus();
  };
  const startTyping = () => {
    setTyping(true);
    setDraft("");
  };
  // Focus goes back to the search field after the view changed (an effect: the closures that ask for it run during row building).
  const [focusAsk, setFocusAsk] = useState(0);
  const refocus = () => setFocusAsk((n) => n + 1);
  useEffect(() => {
    if (focusAsk > 0) input.current?.focus({ preventScroll: true });
  }, [focusAsk]);
  const leaveTyping = () => {
    setTyping(false);
    refocus();
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
    // Decision 95 (`popupNav`): the search is a text field, so plain Home / End move its caret and Ctrl+Home / End jump.
    const to = n
      ? popupMove(
          e,
          true,
          entries.map((x) => x.key),
          row?.key ?? null,
        )
      : null;
    if (to !== null) {
      e.preventDefault();
      setSelected(
        Math.max(
          0,
          entries.findIndex((x) => x.key === to),
        ),
      );
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
    if (row?.kind === "more") {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        act(row);
      }
      return;
    }
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
    if (r.kind === "connect" || r.kind === "more") return prev?.kind === "connect" ? null : "Not set up";
    const group = view.groups.find((g) => g.rows.includes(r));
    const same = prev !== undefined && prev.kind !== "custom" && prev.kind !== "connect" && prev.kind !== "more" && group?.rows.includes(prev);
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
  const rowOf = (r: PickerRow | Custom | More): PickerSection["rows"][number] => {
    const base = { id: r.key, title: rowTitle(r, props.onChooseUnverified !== undefined), run: () => act(r) };
    if (r.kind === "other" && typing)
      return {
        ...base,
        label: "",
        lead: null,
        content: (
          <OtherField
            draft={draft}
            label={`Model name for ${agent?.label ?? "the agent"}`}
            example={agent?.example ?? "opus"}
            onDraft={setDraft}
            onCommit={commitTyped}
            onLeave={leaveTyping}
          />
        ),
      };
    if (r.kind === "more") return { ...base, label: r.label, quiet: true, lead: <Glyph icon={ChevronRight} size={14} className="text-fg-3" /> };
    if (r.kind === "custom") return { ...base, label: `Use “${r.label}”`, hint: "model name" };
    if (r.kind === "connect") {
      const text = r.unsupported ? (r.reason ?? r.state) : r.unverified ? r.state : `${r.state} · ${r.action}`;
      // B13: beside "Check again" the state is a second dim line under the name (a 40px row), so neither the name nor the state
      // truncates at 320px; a right-aligned hint took a fraction of a pixel from the name, enough for "GitHub Co…".
      const note = r.experimental ? "experimental" : null;
      return {
        ...base,
        label: r.label,
        quiet: true,
        lead: <ProviderMark id={r.providerId} label={r.label} className="text-fg-3" />,
        ...(r.unverified ? { sub: note ? `${note} · ${text}` : text } : { hint: text, ...(note ? { detail: note } : {}) }),
        ...(r.unverified
          ? {
              trailing: (
                <UnverifiedActions checking={checking === r.providerId} still={stillOut === r.providerId} onCheck={() => void checkAgain(r.providerId)} />
              ),
            }
          : {}),
      };
    }
    if (r.kind === "other") return { ...base, label: r.label, quiet: true };
    if (r.kind === "agent")
      return {
        ...base,
        label: r.label,
        lead: <ProviderMark id={r.providerId} label={r.label} className="text-fg-3" />,
        trailing: <Glyph icon={ChevronRight} size={14} className="-mr-0.5 shrink-0 text-fg-3" />,
        // With the "experimental" tag beside the name there is no room for the default model on the same line: it is the second line.
        ...(r.experimental ? { detail: "experimental" } : {}),
        ...(r.detail ? (r.experimental ? { sub: r.detail } : { hint: r.detail }) : {}),
      };
    const lead = isCurrent(r) ? <Glyph icon={Check} size={14} className="text-fg" /> : null;
    if (r.kind === "default") return { ...base, label: r.label, lead, ...(r.detail ? { hint: r.detail } : {}) };
    return {
      ...base,
      label: r.agentLabel ? `${r.agentLabel} · ${r.label}` : r.label,
      lead,
      quiet: r.stale === true,
      ...(r.isDefault ? { detail: "default" } : {}),
      ...(r.stale ? { hint: STALE_NOTE } : {}),
      ...(r.removable
        ? {
            trailing: (
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
                className="pointer-events-none -mr-1 opacity-0 transition-opacity duration-fast group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
              />
            ),
          }
        : {}),
    };
  };
  const sections: PickerSection[] = [];
  entries.forEach((r, i) => {
    const title = heading(i);
    let last = sections[sections.length - 1];
    if (!last || title !== null) {
      last = { title: title ?? "", rows: [] };
      sections.push(last);
    }
    last.rows.push(rowOf(r));
  });

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
      className="max-h-[min(640px,calc(100dvh-24px))]! w-[min(320px,calc(100vw-16px))]"
    >
      <SearchField
        ref={input}
        variant="header"
        clearOnEscape={false}
        label={agent ? `Search ${agent.label} models` : "Search models and agents"}
        placeholder={agent ? `Search ${agent.label} models` : props.custom ? "Search, or type a model name" : "Search models and agents"}
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
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-1 py-1">
          <Button variant="quiet" size="xs" icon={ChevronLeft} onClick={back} className="min-w-0 shrink">
            <span className="truncate">{agent.label}</span>
          </Button>
          <Button
            variant="quiet"
            size="xs"
            icon={RefreshCw}
            loading={refreshing}
            onClick={() => void doRefresh()}
            className="shrink-0"
            title={
              agent.refreshedAt
                ? `Refresh ${agent.label}'s model list (updated ${new Date(agent.refreshedAt).toLocaleString()})`
                : `Refresh ${agent.label}'s model list`
            }
          >
            Refresh models
          </Button>
        </div>
      )}
      {why && (
        <p className="shrink-0 px-3 pt-1.5 text-xs text-fg-3">
          {why.reason}
          {why.note && <span className="mt-0.5 line-clamp-2 block">{why.note}</span>}
        </p>
      )}
      {error && (
        <p role="alert" className="shrink-0 px-3 pt-1.5 text-xs text-warn">
          {error}
        </p>
      )}
      <PopupList
        id={listId}
        label={agent ? `${agent.label} models` : "Models and agents"}
        sections={sections}
        activeId={at >= 0 ? (entries[at]?.key ?? null) : null}
        onActive={(id) =>
          setSelected(
            Math.max(
              0,
              entries.findIndex((x) => x.key === id),
            ),
          )
        }
        onChoose={(r) => r.run()}
        query={query}
        tall
        tagDetail
        empty={
          <>
            <span className="min-w-0 flex-1">{empty}</span>
            {!view && load.status === "error" && (
              <Button variant="quiet" size="xs" onClick={() => void refresh()}>
                Try again
              </Button>
            )}
          </>
        }
      />
      {props.footer && !agent && <div className="shrink-0 border-t border-line px-3 py-1.5">{props.footer}</div>}
    </Popover>
  );
}

/**
 * "Check again" on a not-logged-in agent's row; out of the tab order like the row's remove button. One action only, so the
 * name keeps its room at 320px (B13): "Use anyway" is in the connect sheet the row opens (Enter or a click), beside "Check again".
 */
function UnverifiedActions({ checking, still, onCheck }: { checking: boolean; still: boolean; onCheck(): void }) {
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
    </span>
  );
}

function rowTitle(r: PickerRow | Custom | More, canUseAnyway: boolean): string {
  if (r.kind === "more") return `${r.label}: show them`;
  if (r.kind === "custom") return r.agentId ? `Use “${r.label}” as the model name` : `Use “${r.value}” as the model name`;
  if (r.kind === "connect") {
    if (r.unsupported) return `${r.label}: ${r.reason ?? r.state}`;
    return r.unverified && canUseAnyway ? `${r.label}: ${r.state}. ${USE_ANYWAY_NOTE}` : `${r.label}: ${r.state}`;
  }
  if (r.kind === "other") return "Type the name of a model this agent accepts";
  if (r.kind === "agent") return `${r.label}: choose a model`;
  if (r.kind === "default") return "No model named: the agent uses its own default";
  const how =
    r.source === "custom" ? "added by you" : r.source === "advertised" ? "offered by the agent" : r.source === "command" ? "listed by the agent" : null;
  const note = r.stale ? STALE_NOTE : how;
  return note ? `${r.value} (${note})` : r.value;
}

/** The "Other model…" row while typing: a bare field inside the list; Enter commits, ↑/↓ go back to the search field. */
function OtherField(props: { draft: string; label: string; example: string; onDraft(value: string): void; onCommit(): void; onLeave(): void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <TextField
      ref={field}
      variant="bare"
      value={props.draft}
      aria-label={props.label}
      placeholder={`e.g. ${props.example}`}
      onChange={(e) => props.onDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          props.onCommit();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onLeave();
        }
      }}
    />
  );
}
