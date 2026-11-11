import type { Folder, TierPolicy } from "@octo/agent-client";
import { ArrowUp, Clock, Plus, Square } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useChatSlots } from "../../state/chatSlots";
import { errorMessage } from "../../lib/format";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Presence } from "../primitives/Presence";
import { withAttachments } from "./attachments";
import { ComposerMenu, type ComposerMenuHandle, type MenuPick } from "./ComposerMenu";
import { FolderChip, ModelChip, TierChip, useShedLabels } from "./ComposerChips";
import { ComposerPills, type QueuedMessage } from "./ComposerPills";
import { ContextRing } from "./ContextRing";
import { useAnimationGate, useAuroraState } from "./useAnimationGate";
import { useAttachments } from "./useAttachments";
import { useComposerText, type ComposerDraft } from "./useComposerText";

export type ComposerHandle = { focus(): void; fill(text: string): void };

export type ComposerProps = {
  running: boolean;
  /** The last turn failed (the edge drains to danger once). */
  failed: boolean;
  disabledReason: string | null;
  folders: Folder[];
  /** The orchestrator's model or agent (choose rejects to roll back). */
  model: { value: string; title?: string | undefined; unavailable?: boolean; choose(model: string): Promise<void> } | null;
  /** One quiet line above the box (no API key), with the reason in its tooltip. */
  notice?: { text: string; title?: string } | null;
  /** Decision 49: the folder chip's picker adds the chosen folder to the project. */
  onAddFolder?: ((path: string) => void) | undefined;
  /** The router's tier policy; null without a router. */
  tier: { value: TierPolicy; choose(policy: TierPolicy): Promise<void> } | null;
  /** The orchestrator's context window, for the meter. */
  context: { used: number | null | undefined; size: number | null | undefined };
  /** The newest request, recalled by ↑ in an empty field. */
  lastRequest: string | null;
  onSend(text: string): Promise<void>;
  onCancel(): Promise<void>;
  /** The harness keeps the queue (`sendOrQueueMessage`): a message written while a turn runs goes through `onSend`, not the local queue. */
  serverQueue?: boolean;
  /** Messages written while a turn runs; sent one by one when it ends. */
  queue: { items: QueuedMessage[]; add(text: string): void; remove(id: string): void };
  /** Keeps an unsent draft across remounts and shares it with the other composer on the same key. */
  draft?: ComposerDraft | undefined;
  /** Pending code comments go out with the next message (which may then have no text). */
  comments?: { count: number; render(open: boolean, setOpen: (open: boolean) => void): ReactNode } | undefined;
  /** Floating over a file view: a shadow instead of the hairline. */
  floating?: boolean;
  /** A popover of the composer opened or closed (the conversation hides "Jump to latest" meanwhile, decision 56). */
  onOverlay?(open: boolean): void;
};

/** `/` or `@` at the start of a word, up to the caret: the "+" menu's inline query. */
const TRIGGER = /(^|\s)([/@])([^\s/@]*)$/;

type MenuState = { mode: "button" } | { mode: "inline"; start: number; query: string };

/** Chips that can shed their label (tier, folder, model). */
const SHEDDABLE = 3;

/**
 * The composer (decision 62): one container (radius 14, raised, hairline that brightens on focus; the aurora edge
 * while the orchestrator works). Inside: the pills (queued messages, line comments, attached files), the text area
 * (1–10 lines), and the control row — "+", the model / folder / tier chips (labels shed tier → folder → model when
 * narrow), the context ring and one round button that is Send, Stop, or Queue.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, handle) {
  const { text, setText, area, place } = useComposerText(props.draft);
  const attach = useAttachments();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<{ model: string; message: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [chipOpen, setChipOpen] = useState(0);
  const box = useRef<HTMLFormElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const menuRef = useRef<ComposerMenuHandle>(null);
  const listId = useId();
  const slots = useChatSlots();
  const [queuedCount, setQueuedCount] = useState(0);
  const aurora = useAuroraState(props.running, props.failed);
  const frame = useRef<HTMLDivElement>(null);
  const paused = useAnimationGate(frame, aurora !== "off");

  useImperativeHandle(handle, () => ({ focus: () => area.current?.focus(), fill: (value) => place(value) }));

  const overlay = menu !== null || commentsOpen || chipOpen > 0;
  const onOverlay = props.onOverlay;
  useEffect(() => onOverlay?.(overlay), [overlay, onOverlay]);
  useEffect(() => () => onOverlay?.(false), [onOverlay]);
  const onChip = useCallback((open: boolean) => setChipOpen((n) => Math.max(0, n + (open ? 1 : -1))), []);

  const disabled = props.disabledReason !== null;
  const pendingComments = props.comments?.count ?? 0;
  const hasContent = text.trim().length > 0 || attach.files.length > 0 || pendingComments > 0;
  const canSend = !disabled && !sending && hasContent;
  const shed = useShedLabels(row, SHEDDABLE, `${props.model?.value}|${props.folders.length}|${props.tier?.value}`);

  const outgoing = () => withAttachments(text.trim(), attach.files);
  const queue = () => {
    const message = outgoing();
    if (!message || disabled) return;
    props.queue.add(message);
    setText("");
    attach.clear();
  };
  const submit = async () => {
    if (!canSend) return;
    if (props.running && !props.serverQueue) return queue();
    setSending(true);
    setError(null);
    try {
      await props.onSend(outgoing());
      setText("");
      attach.clear();
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
  }, [area]);
  const openComments = useCallback(() => setCommentsOpen(true), []);

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
    place(before + lead + insert + after, (before + lead + insert).length + (insert === p.insert ? 0 : 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu?.mode === "inline" && menuRef.current?.onKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        if (props.running && !props.serverQueue) queue();
        else void submit();
      } else void submit();
      return;
    }
    if (e.key === "ArrowUp" && !text && props.lastRequest && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      place(props.lastRequest);
      return;
    }
    if (e.key === "Escape" && props.running && !menu) {
      e.preventDefault();
      void props.onCancel();
    }
  };

  const model = props.model;
  const chooseModel = (next: string) => {
    if (!model) return;
    setModelError(null);
    model.choose(next).catch((e: unknown) => setModelError({ model: next, message: errorMessage(e) }));
  };
  const inlineOpen = menu?.mode === "inline";
  const action = props.running ? (hasContent ? "queue" : "stop") : "send";

  return (
    <div data-composer-wrap>
      {error && (
        <Notice>
          <span className="text-err">Couldn't send.</span> {error.replace(/\.$/, "")}. Your message is still in the box.
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void submit()} disabled={!canSend}>
            Retry
          </Button>
        </Notice>
      )}
      {modelError && (
        <Notice>
          <span className="text-err">Couldn't switch the model.</span> {modelError.message.replace(/\.$/, "")}. The orchestrator keeps its previous one.
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => chooseModel(modelError.model)}>
            Retry
          </Button>
        </Notice>
      )}
      {props.notice && (
        <p className="mb-2 px-3 text-sm text-fg-3" title={props.notice.title}>
          {props.notice.text}
        </p>
      )}
      {attach.note && (
        <Notice>
          <span className="text-fg-2">{attach.note}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={attach.dismissNote}>
            Dismiss
          </Button>
        </Notice>
      )}
      <div ref={frame} className="octo-aurora-frame" data-aurora={aurora === "off" ? undefined : aurora} data-paused={paused || undefined}>
        <span aria-hidden className="octo-aurora-glow" />
        <form
          ref={box}
          data-composer
          data-drop={attach.dragging || undefined}
          data-floating={props.floating || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onMouseDown={(e) => {
            // A click on the container's padding still puts the caret in the text.
            if (e.target === e.currentTarget) {
              e.preventDefault();
              area.current?.focus();
            }
          }}
          {...attach.dropProps}
          className={cn("octo-composer relative isolate flex flex-col bg-raised", disabled && "opacity-80")}
        >
          {slots?.queue?.({ onCount: setQueuedCount })}
          <ComposerPills
            files={attach.files}
            onRemoveFile={attach.remove}
            queue={props.queue.items}
            onUnqueue={props.queue.remove}
            comments={pendingComments > 0 ? props.comments?.render(commentsOpen, setCommentsOpen) : null}
          />
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
              syncTrigger(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => inlineOpen && syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={attach.onPaste}
            onBlur={() => inlineOpen && setMenu(null)}
            placeholder={props.disabledReason ?? "Ask anything, @ to mention a file"}
            aria-autocomplete="list"
            aria-expanded={inlineOpen}
            aria-controls={inlineOpen ? listId : undefined}
            aria-activedescendant={inlineOpen && activeOption ? activeOption : undefined}
            aria-keyshortcuts="Enter Shift+Enter Control+Enter Escape"
            className="octo-composer-input block w-full resize-none overscroll-contain bg-transparent px-3 pt-3 wrap-anywhere text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
          />
          <div ref={row} data-composer-row className="flex h-10 min-w-0 items-center gap-1 px-1.5 pb-1.5">
            <button
              ref={plus}
              type="button"
              aria-label="Attach, mention or run"
              title="Attach a file, mention, or run an action ( / or @ )"
              aria-haspopup="listbox"
              aria-expanded={menu?.mode === "button"}
              disabled={disabled}
              onClick={() => setMenu((m) => (m?.mode === "button" ? null : { mode: "button" }))}
              className={cn(
                "relative grid size-7 shrink-0 press place-items-center rounded-sm text-fg-2 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50",
                menu?.mode === "button" && "bg-active text-fg",
              )}
            >
              <Glyph icon={Plus} size={16} />
            </button>
            {model && (
              <ModelChip
                value={model.value}
                title={model.title}
                unavailable={model.unavailable === true}
                onChoose={chooseModel}
                bare={shed >= 3}
                disabled={disabled}
                onOpenChange={onChip}
              />
            )}
            <FolderChip folders={props.folders} onAdd={props.onAddFolder} bare={shed >= 2} disabled={disabled} onOpenChange={onChip} />
            {props.tier && (
              <TierChip
                value={props.tier.value}
                onChoose={(p) => void props.tier?.choose(p).catch(() => undefined)}
                bare={shed >= 1}
                disabled={disabled}
                onOpenChange={onChip}
              />
            )}
            <span className="min-w-0 flex-1" />
            <ContextRing used={props.context.used} size={props.context.size} />
            <SendButton
              action={action}
              enabled={action === "stop" ? !disabled : canSend}
              onStop={() => void props.onCancel()}
              badge={slots?.badge?.(queuedCount)}
            />
          </div>
        </form>
        <span aria-hidden className="octo-aurora">
          <span className="octo-aurora-spin" />
        </span>
      </div>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <ComposerMenu
            ref={menuRef}
            anchor={menu.mode === "button" ? plus : box}
            box={box}
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

function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-sm text-fg-2">
      {children}
    </div>
  );
}

const SEND = {
  send: { icon: ArrowUp, label: "Send (Enter)" },
  queue: { icon: Clock, label: "Queue: send when this turn ends (Enter)" },
  stop: { icon: Square, label: "Stop the turn (Esc)" },
} as const;

/** One 28px round button: Send (dim while empty), Stop while working, Queue while working with text (decision 62). */
function SendButton({ action, enabled, onStop, badge }: { action: "send" | "queue" | "stop"; enabled: boolean; onStop(): void; badge?: ReactNode }) {
  const { icon, label } = SEND[action];
  const solid = enabled && action !== "stop";
  return (
    <button
      type={action === "stop" ? "button" : "submit"}
      onClick={action === "stop" ? onStop : undefined}
      disabled={!enabled}
      aria-label={label}
      title={label}
      data-action={action}
      className={cn(
        "grid size-7 shrink-0 press place-items-center rounded-full transition-[background-color,color] duration-100",
        solid ? "bg-primary text-primary-fg hover:opacity-90" : action === "stop" ? "bg-active text-fg hover:bg-line-strong" : "bg-hover text-fg-3",
      )}
    >
      <Glyph icon={icon} size={action === "stop" ? 14 : 16} fill={action === "stop" ? "currentColor" : "none"} />
      {badge}
    </button>
  );
}
