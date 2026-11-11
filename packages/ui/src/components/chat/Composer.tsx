import type { Folder, Models, TierPolicy } from "@octo/agent-client";
import { ArrowUp, Ellipsis, Plus, Route, Square } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
import { Presence } from "../primitives/Presence";
import type { ComposerMenuHandle, MenuPick } from "./ComposerMenu";

/** The "+" menu loads when first opened (prefetched when the composer takes focus): its own chunk. */
const loadMenu = () => import("./ComposerMenu");
const ComposerMenu = lazy(() => loadMenu().then((m) => ({ default: m.ComposerMenu })));
import { ModelPicker } from "../shared/ModelPicker";
import { errorMessage } from "../../lib/format";
import { policyLabel, TIER_POLICIES } from "../../lib/models";
import { Menu, type MenuItem } from "../primitives/Menu";
import { IconButton } from "../primitives/Button";

export type ComposerHandle = { focus(): void; fill(text: string): void };

export type ComposerProps = {
  running: boolean;
  disabledReason: string | null;
  /** The conversation already has messages: the placeholder invites a follow-up. */
  followUp: boolean;
  folders: Folder[];
  /** The orchestrator model picker (choose rejects to roll back): the project's tiers and the model ids the harness knows. */
  model: {
    value: string;
    known: string[];
    tiers: Pick<Models, "fast" | "balanced" | "deep"> | null;
    /** Decision 48: the tooltip when a router served another model ("Sonnet 5.5 → deepseek-v4.1-flash"). */
    title?: string | undefined;
    choose(model: string): Promise<void>;
  } | null;
  /** The project's routing policy, when a router is detected (decision 37). */
  policy?: { value: TierPolicy; onChange(policy: TierPolicy): void } | null;
  /** The folders button: opens the project's settings. */
  onFolders?: (() => void) | undefined;
  /** One quiet line above the box (no API key: decision ACP), with an optional way forward. */
  notice?: { text: string; title?: string; action?: { label: string; run(): void } } | null;
  onSend(text: string): Promise<void>;
  onCancel(): Promise<void>;
  /** Keeps an unsent draft across remounts and shares it with the other composer on the same key. */
  draft?: { initial: string; save(text: string): void; subscribe?(cb: (text: string) => void): () => void } | undefined;
  /** Pending code comments go out with the next message (which may then have no text). */
  comments?: { count: number; render(open: boolean, setOpen: (open: boolean) => void): ReactNode } | undefined;
  /** Opens the pending-comments list from the "+" menu when it lives elsewhere (the floating composer's chip). */
  onOpenComments?(): void;
  /** Floating over a file view: a shadow instead of the hairline, the model inside the box, no footer. */
  floating?: boolean;
};

const MAX_HEIGHT_VH = 0.4;
/** `/` or `@` at the start of a word, up to the caret: the "+" menu's inline query. */
const TRIGGER = /(^|\s)([/@])([^\s/@]*)$/;

type MenuState = { mode: "button" } | { mode: "inline"; start: number; query: string };

/**
 * Decision 30 — two fused layers in one outline (radius 12, a hairline between): the input row — [28px "+"] 8 [text]
 * 8 [28px send / stop], growing with the text (controls stay on the last line) — and under it a 28px context bar of
 * quiet buttons: folders (opens project settings), model (the picker of decision 27), routing (when a router is
 * detected), pending comments; on the right the key hint while the box is empty and focused. Under 420px the bar
 * keeps the model and folds folders and routing into `…`. The floating composer has the same two layers. The "+"
 * menu (button, or `/` / `@` at a word start) inserts file paths and agent hints, or runs an action.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, handle) {
  const [text, setText] = useState(() => props.draft?.initial ?? "");
  const saveDraft = props.draft?.save;
  useEffect(() => {
    saveDraft?.(text);
  }, [text, saveDraft]);
  const subscribe = props.draft?.subscribe;
  useEffect(() => subscribe?.((t) => setText((cur) => (cur === t ? cur : t))), [subscribe]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<{ model: string; message: string } | null>(null);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [busyHint, setBusyHint] = useState(false);
  useEffect(() => {
    if (!props.running) setBusyHint(false);
  }, [props.running]);
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLFormElement>(null);
  const menuRef = useRef<ComposerMenuHandle>(null);
  const listId = useId();

  useImperativeHandle(handle, () => ({
    focus: () => area.current?.focus(),
    fill: (value) => {
      setText(value);
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(value.length, value.length);
      });
    },
  }));

  const fit = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * MAX_HEIGHT_VH))}px`;
  }, []);

  useLayoutEffect(fit, [text, fit]);

  // Wrapping changes when the width does (window resize, side panel toggling), so refit then too.
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const disabled = props.disabledReason !== null;
  const pendingComments = props.comments?.count ?? 0;
  const canSend = !disabled && !props.running && !sending && (text.trim().length > 0 || pendingComments > 0);

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(text.trim());
      setText("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  /** Re-reads the word at the caret: opens, updates or closes the inline menu. */
  const syncTrigger = (value: string, caret: number) => {
    const m = TRIGGER.exec(value.slice(0, caret));
    const query = m?.[3];
    if (query !== undefined) setMenu({ mode: "inline", start: caret - query.length - 1, query });
    else setMenu((cur) => (cur?.mode === "inline" ? null : cur));
  };

  // Closing the button-opened menu (Esc, a pick) gives focus back to the text.
  const closeMenu = useCallback(() => {
    setMenu((cur) => {
      if (cur?.mode === "button") requestAnimationFrame(() => area.current?.focus());
      return null;
    });
  }, []);
  const onOpenComments = props.onOpenComments;
  const openComments = useCallback(() => (onOpenComments ? onOpenComments() : setCommentsOpen(true)), [onOpenComments]);

  const pick = (p: MenuPick) => {
    const el = area.current;
    const current = menu;
    setMenu(null);
    if ("run" in p) {
      // Inline: the trigger and its query were only a way into the menu.
      if (current?.mode === "inline" && el) setText(text.slice(0, current.start) + text.slice(el.selectionStart));
      p.run();
      return;
    }
    const caret = el?.selectionStart ?? text.length;
    const from = current?.mode === "inline" ? current.start : caret;
    const to = current?.mode === "inline" ? caret : (el?.selectionEnd ?? caret);
    const before = text.slice(0, from);
    const after = text.slice(to);
    const lead = before && !/\s$/.test(before) ? " " : "";
    // Never two spaces: the pick's trailing space is dropped when a space already follows.
    const insert = /^\s/.test(after) ? p.insert.replace(/\s+$/, "") : p.insert;
    const next = before + lead + insert + after;
    setText(next);
    const at = (before + lead + insert).length + (insert === p.insert ? 0 : 1);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu?.mode === "inline" && menuRef.current?.onKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // A running turn takes no new message (queueing is a harness feature to come): say so, quietly.
      if (props.running && text.trim()) setBusyHint(true);
      void submit();
    }
  };

  const placeholder = disabled
    ? props.disabledReason!
    : pendingComments > 0
      ? "Add a message (optional)"
      : props.followUp
        ? "Next request…"
        : "Ask the orchestrator…";
  const folders = props.folders.map((f) => f.label).join(", ");
  const model = props.model;
  const chooseModel = (next: string) => {
    if (!model) return;
    setModelError(null);
    model.choose(next).catch((e: unknown) => setModelError({ model: next, message: errorMessage(e) }));
  };
  const policy = props.policy ?? null;
  const control = "press grid size-7 shrink-0 place-items-center rounded-sm";
  const quiet = "flex h-chip min-w-0 shrink-0 press items-center gap-1.5 rounded-sm px-1.5 text-xs text-fg-2 whitespace-nowrap hover:bg-hover hover:text-fg";
  const inlineOpen = menu?.mode === "inline";

  return (
    <div data-composer>
      {error && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-sm">
          <p className="min-w-0 flex-1 text-fg-2">
            <span className="text-err">Couldn't send.</span> {error.replace(/\.$/, "")}. Your message is still in the box.
          </p>
          <Button size="sm" onClick={() => void submit()} disabled={!canSend}>
            Retry
          </Button>
        </div>
      )}
      {modelError && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-sm">
          <p className="min-w-0 flex-1 text-fg-2">
            <span className="text-err">Couldn't switch the orchestrator model.</span> {modelError.message.replace(/\.$/, "")}. It still uses{" "}
            {model?.value ?? "the previous model"}.
          </p>
          <Button size="sm" onClick={() => chooseModel(modelError.model)}>
            Retry
          </Button>
        </div>
      )}
      {busyHint && (
        <p role="status" className="mb-2 px-4 text-sm text-fg-2">
          The orchestrator is still working. Send this when the turn ends, or stop it first.
        </p>
      )}
      {props.notice && (
        <p data-composer-notice title={props.notice.title} className="mb-2 flex flex-wrap items-center gap-x-2 px-1.5 text-sm text-fg-2">
          <span className="min-w-0">{props.notice.text}</span>
          {props.notice.action && (
            <button
              type="button"
              onClick={props.notice.action.run}
              className="h-chip press rounded-sm px-1.5 text-sm text-fg underline-offset-2 hover:bg-hover"
            >
              {props.notice.action.label}
            </button>
          )}
        </p>
      )}
      <div
        data-composer-box
        className={cn(
          "@container/composer rounded-xl bg-raised outline -outline-offset-1 transition-[outline-color] duration-100",
          props.floating ? "shadow-float outline-line" : "outline-line",
          !disabled && "focus-within:outline-focus",
        )}
      >
        <form
          ref={box}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex items-end gap-2 p-1.5"
          onMouseDown={(e) => {
            // Clicking the padding around the textarea still puts the caret in it.
            if (e.target === e.currentTarget) {
              e.preventDefault();
              area.current?.focus();
            }
          }}
        >
          <button
            type="button"
            aria-label="Insert a file, agent or action"
            title="Insert a file, agent or action"
            data-shortcut="/"
            aria-haspopup="listbox"
            aria-expanded={menu?.mode === "button"}
            disabled={disabled}
            onClick={() => setMenu((m) => (m?.mode === "button" ? null : { mode: "button" }))}
            className={cn(
              control,
              "text-fg-3 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
              menu?.mode === "button" && "bg-active text-fg",
            )}
          >
            <Glyph icon={Plus} size={16} />
          </button>
          <label htmlFor={props.floating ? "octo-composer-float" : "octo-composer"} className="sr-only">
            Message the orchestrator
          </label>
          <textarea
            id={props.floating ? "octo-composer-float" : "octo-composer"}
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              setBusyHint(false);
              syncTrigger(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => inlineOpen && syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true);
              // A failed prefetch is retried by the first open (the menu's own import).
              loadMenu().catch(() => undefined);
            }}
            onBlur={() => {
              setFocused(false);
              if (inlineOpen) setMenu(null);
            }}
            placeholder={placeholder}
            aria-autocomplete="list"
            aria-expanded={inlineOpen}
            aria-controls={inlineOpen ? listId : undefined}
            aria-activedescendant={inlineOpen && activeOption ? activeOption : undefined}
            aria-describedby={props.floating ? undefined : `${listId}-hint`}
            className="block max-h-[40vh] min-w-0 flex-1 resize-none self-center overscroll-contain bg-transparent py-0.5 text-base leading-6 wrap-anywhere text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
          />
          {props.running ? (
            <button
              type="button"
              onClick={() => void props.onCancel()}
              aria-label="Stop the current turn"
              title="Stop"
              className={cn(control, "bg-hover text-fg hover:bg-active")}
            >
              <Glyph icon={Square} size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send"
              className={cn(
                control,
                // Decision 33: quiet (fg on the hover fill) while there is nothing to send; solid only when there is.
                canSend ? "bg-primary text-primary-fg hover:opacity-90" : "bg-hover text-fg-3 disabled:opacity-100",
              )}
            >
              <Glyph icon={ArrowUp} size={16} />
            </button>
          )}
        </form>
        {/* The context bar, 28px under a hairline: controls start on the box's inner edge (6) and the hint ends on it. */}
        <div data-context-bar className="flex h-row min-w-0 items-center gap-1 border-t border-line px-1.5 text-xs max-md:h-bar [&_button]:max-md:min-h-10">
          {model && (
            <ModelPicker
              label="Orchestrator model"
              value={model.value}
              known={model.known}
              {...(model.tiers ? { tiers: model.tiers } : {})}
              policy={policy}
              {...(model.title ? { title: model.title } : {})}
              onChoose={chooseModel}
              disabled={disabled}
              className="min-w-0 shrink"
            />
          )}
          {/* The folders the orchestrator works in (glyph = the Files meaning); opens the project's settings. */}
          <button
            type="button"
            onClick={props.onFolders}
            disabled={!props.onFolders}
            title={props.folders.map((f) => f.path).join("\n") || "No folders attached: add one in project settings"}
            aria-label={`Folders: ${folders || "none"}`}
            className={cn(quiet, "min-w-0 shrink text-fg-3 disabled:pointer-events-none @max-[420px]/composer:hidden")}
          >
            <Glyph icon={GLYPH.files} size={14} className="shrink-0" />
            <span className="min-w-0 truncate">{folders || "No folders attached"}</span>
          </button>
          {policy && <RoutingButton policy={policy} />}
          {(props.onFolders || policy) && <FoldMenu folders={folders} onFolders={props.onFolders} policy={policy} />}
          {pendingComments > 0 && props.comments?.render(commentsOpen, setCommentsOpen)}
          <p id={`${listId}-hint`} className={cn("ml-auto flex shrink-0 items-center gap-3 pl-2 text-fg-3 max-sm:hidden", !(focused && !text) && "hidden")}>
            <span>
              <kbd className="font-sans">↵</kbd> send
            </span>
            <span>
              <kbd className="font-sans">⇧↵</kbd> new line
            </span>
            <span>
              <kbd className="font-sans">/</kbd> insert
            </span>
          </p>
        </div>
      </div>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Suspense fallback={null}>
            <ComposerMenu
              ref={menuRef}
              anchor={box}
              query={menu.mode === "inline" ? menu.query : null}
              listId={listId}
              onActive={setActiveOption}
              pendingComments={pendingComments}
              onOpenComments={openComments}
              onPick={pick}
              onClose={closeMenu}
            />
          </Suspense>
        )}
      </Presence>
    </div>
  );
});

/** The routing policy in the context bar (decision 30): a quiet button whose menu sets Auto / Ceiling / Fixed. */
function RoutingButton({ policy }: { policy: { value: TierPolicy; onChange(policy: TierPolicy): void } }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`Routing: ${policyLabel(policy.value)}`}
        title="How the router treats the tier: Auto may go lower or higher, Ceiling never above, Fixed exactly"
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: r.left, y: r.top - 4 });
        }}
        className={cn(
          "flex h-chip shrink-0 press items-center gap-1.5 rounded-sm px-1.5 text-xs whitespace-nowrap hover:bg-hover hover:text-fg @max-[420px]/composer:hidden",
          menu ? "bg-active text-fg" : "text-fg-3",
        )}
      >
        <Glyph icon={Route} size={14} className="shrink-0" />
        {policyLabel(policy.value)}
      </button>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Routing policy"
            x={menu.x}
            y={menu.y}
            above
            onClose={() => setMenu(null)}
            items={TIER_POLICIES.map((p) => ({
              id: p.value,
              label: `${p.label} — ${p.detail.toLowerCase()}`,
              checked: p.value === policy.value,
              run: () => policy.onChange(p.value),
            }))}
          />
        )}
      </Presence>
    </>
  );
}

/** Under 420px the bar keeps the model; folders and routing fold into this `…` (decision 30). */
function FoldMenu(props: { folders: string; onFolders: (() => void) | undefined; policy: { value: TierPolicy; onChange(policy: TierPolicy): void } | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items: MenuItem[] = [];
  if (props.onFolders) items.push({ id: "folders", label: `Folders: ${props.folders || "none"}`, run: props.onFolders });
  if (props.policy) {
    const p = props.policy;
    if (items.length) items.push({ id: "sep", separator: true });
    for (const t of TIER_POLICIES) items.push({ id: t.value, label: `Routing: ${t.label}`, checked: t.value === p.value, run: () => p.onChange(t.value) });
  }
  return (
    <span className="hidden @max-[420px]/composer:flex">
      <IconButton
        ref={button}
        icon={Ellipsis}
        size="sm"
        label="Folders and routing"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: r.left, y: r.top - 4 });
        }}
      />
      <Presence show={menu !== null} exitMs={0}>
        {menu && <Menu label="Folders and routing" x={menu.x} y={menu.y} above items={items} onClose={() => setMenu(null)} />}
      </Presence>
    </span>
  );
}
