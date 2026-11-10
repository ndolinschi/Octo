import type { Folder } from "@octo/agent-client";
import { ArrowUp, Plus, Square } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
import { Presence } from "../primitives/Presence";
import { ComposerMenu, type ComposerMenuHandle, type MenuPick } from "./ComposerMenu";
import { ModelSelect } from "./ModelSelect";

export type ComposerHandle = { focus(): void; fill(text: string): void };

export type ComposerProps = {
  running: boolean;
  disabledReason: string | null;
  /** The conversation already has messages: the placeholder invites a follow-up. */
  followUp: boolean;
  folders: Folder[];
  /** The orchestrator model selector (choose rejects to roll back). */
  model: { value: string; options: string[]; choose(model: string): Promise<void> } | null;
  onSend(text: string): Promise<void>;
  onCancel(): Promise<void>;
  /** Keeps an unsent draft across remounts and shares it with the other composer on the same key. */
  draft?: { initial: string; save(text: string): void; subscribe?(cb: (text: string) => void): () => void };
  /** Pending code comments go out with the next message (which may then have no text). */
  comments?: { count: number; render(open: boolean, setOpen: (open: boolean) => void): ReactNode };
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
 * One rounded box (radius 12, 6px inset, a 1px edge drawn as an outline so it takes no room): 40px tall
 * with one line — [28px "+"] 8 [text] 8 [28px send / stop] — and growing with the text (controls stay
 * on the last line). Below it (not when floating) a 24px footer: the orchestrator model and the
 * folders on the left; on the right, while the box is empty and focused, the key hint. The "+" menu
 * (button, or `/` / `@` at a word start) inserts file paths and agent hints, or runs an action.
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  /** Re-reads the word at the caret: opens, updates or closes the inline menu. */
  const syncTrigger = (value: string, caret: number) => {
    const m = TRIGGER.exec(value.slice(0, caret));
    if (m) setMenu({ mode: "inline", start: caret - m[3].length - 1, query: m[3] });
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
        ? "Send follow-up"
        : "Message the orchestrator";
  const folders = props.folders.map((f) => f.label).join(", ");
  const model = props.model;
  const chooseModel = (next: string) => {
    if (!model) return;
    setModelError(null);
    model.choose(next).catch((e: unknown) => setModelError({ model: next, message: e instanceof Error ? e.message : String(e) }));
  };
  const modelSelect = model && <ModelSelect value={model.value} options={model.options} onChoose={chooseModel} disabled={disabled} />;
  const control = "press grid size-7 shrink-0 place-items-center rounded-sm";
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
      <form
        ref={box}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          "flex items-end gap-2 rounded-xl bg-raised p-1.5 outline -outline-offset-1 transition-[outline-color] duration-100",
          props.floating ? "shadow-float outline-transparent" : "outline-line",
          !disabled && "focus-within:outline-focus",
        )}
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
          onFocus={() => setFocused(true)}
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
        {props.floating && modelSelect && <span className="flex h-7 shrink-0 items-center">{modelSelect}</span>}
        {props.running ? (
          <button
            type="button"
            onClick={() => void props.onCancel()}
            aria-label="Stop the current turn"
            title="Stop"
            className={cn(control, "bg-primary text-primary-fg hover:opacity-90")}
          >
            <Glyph icon={Square} size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
            className={cn(control, "bg-primary text-primary-fg hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100")}
          >
            <Glyph icon={ArrowUp} size={16} />
          </button>
        )}
      </form>
      {!props.floating && (
        // Footer, 24px: controls start on the box's inner edge (6) and the hint ends on it.
        <div className="mt-1 flex h-6 min-w-0 items-center gap-1 px-1.5 text-xs">
          {modelSelect}
          {pendingComments > 0 && props.comments?.render(commentsOpen, setCommentsOpen)}
          {/* The folders the orchestrator works in (glyph = the Files meaning). */}
          <p className="flex min-w-0 items-center gap-1.5 px-2 text-fg-3" title={props.folders.map((f) => f.path).join("\n") || undefined}>
            <Glyph icon={GLYPH.files} size={14} className="shrink-0" />
            <span className="min-w-0 truncate">{folders || "No folders attached"}</span>
          </p>
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
      )}
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
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
        )}
      </Presence>
    </div>
  );
});
