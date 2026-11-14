import type { Folder, TierPolicy } from "@octo/agent-client";
import { ArrowUp, Clock, Plus, Square } from "lucide-react";
import { flushSync } from "react-dom";
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { useChatSlots } from "../../state/chatSlots";
import { errorMessage } from "../../lib/format";
import { canForce, refusedProvider } from "../../lib/providers/refusal";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Presence } from "../primitives/Presence";
import { withAttachments } from "./attachments";
import type { ComposerMenuHandle, MenuPick } from "./ComposerMenu";
import { modeNote } from "../../lib/modes";
import { FolderChip, ModelChip } from "./ComposerChips";
import type { ComposerSession } from "./SessionChip";
import type { ComposerMode } from "./composerMode";
import type { QueuedMessage } from "./ComposerPills";
import { useAttachments } from "./useAttachments";
import { useImages } from "./useImages";
import { useHost } from "../../state/host";
import type { FileInputHandle } from "../primitives/FileInput";
import { useAgentName } from "./agentName";
import { errorCode as errorCodeOf, structuredError } from "../../lib/format";
import type { SlashMenuHandle } from "./SlashMenu";
import { octoCommandFor, slashQuery, type SlashRow } from "../../lib/slash";
import { useSlashCommands, useSlashRunner } from "./useSlash";
import { useComposerText, type ComposerDraft } from "./useComposerText";
import { SENDING_NOTICE_MS } from "../../lib/constants";
import { clearStopping, markStopping, STILL_STOPPING_MS, useStopping } from "../../lib/stopping";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { mayNearLimit, plainShaping, triggerAt } from "../../lib/composerInput";
import type * as SizeModule from "../../lib/messageSize";
import { usePhone } from "../../lib/phone";
import { deviceMay, ON_YOUR_COMPUTER } from "../../lib/remoteDevice";

const ErrorNotice = lazy(() => import("../shared/ErrorNotice").then((m) => ({ default: m.ErrorNotice })));
const ModelRefusedActions = lazy(() => import("../shared/ModelRefusedActions").then((m) => ({ default: m.ModelRefusedActions })));
/** Parts of the composer that only matter once used load on demand (the initial bundle budget). */
const ComposerMenu = lazy(() => import("./ComposerMenu").then((m) => ({ default: m.ComposerMenu })));
const ModeChip = lazy(() => import("./ModeChip").then((m) => ({ default: m.ModeChip })));
/** The pills band (queued messages, attachments, images, comments) only exists while there is something in it. */
const ComposerPills = lazy(() => import("./ComposerPills").then((m) => ({ default: m.ComposerPills })));
const RoutingLine = lazy(() => import("./RoutingLine").then((m) => ({ default: m.RoutingLine })));
const SlashMenu = lazy(() => import("./SlashMenu").then((m) => ({ default: m.SlashMenu })));
/** The context gauge shows once the harness reports the context's size (after the project's state loads): warmed after first paint. */
const ContextRing = lazy(() => import("./ContextRing").then((m) => ({ default: m.ContextRing })));
/** Decision 96: the session chip at the top of the box (its own chunk; its row is reserved meanwhile, so nothing moves). */
const SessionChip = lazy(() => import("./SessionChip").then((m) => ({ default: m.SessionChip })));
/** The hidden file input behind "Attach image…": its own chunk, fetched with the composer's first render (entry budget). */
const FileInput = lazy(() => import("../primitives/FileInput").then((m) => ({ default: m.FileInput })));
const ComposerHighlight = lazy(() => import("./ComposerHighlight").then((m) => ({ default: m.ComposerHighlight })));

export type ComposerHandle = {
  focus(): void;
  fill(text: string): void;
  /** "Keep editing" on a plan: Plan mode for the next message, and the caret in the text. */ refinePlan(): void;
  /** Files dropped on the conversation: images become chips, text files pills. */
  addFiles(files: File[]): void;
};

export type { ComposerMode };

export type ComposerProps = {
  running: boolean;
  disabledReason: string | null;
  folders: Folder[];
  /** The orchestrator's model or agent (choose rejects to roll back). */
  model: { value: string; title?: string | undefined; unavailable?: boolean; choose(model: string, force?: boolean): Promise<void> } | null;
  /** One quiet line above the box (no API key), with the reason in its tooltip. */
  notice?: { text: string; title?: string } | null;
  /** Decision 49: the folder chip's picker adds the chosen folder to the project. */
  onAddFolder?: ((path: string) => void) | undefined;
  /** The router's tier policy; null without a router. */
  tier: { value: TierPolicy; choose(policy: TierPolicy): Promise<void> } | null;
  /** Null when the harness has no modes. */
  mode?: ComposerMode | null;
  /** The orchestrator's context window, for the meter. */
  context: { used: number | null | undefined; size: number | null | undefined };
  /** The newest request, recalled by ↑ in an empty field. */
  lastRequest: string | null;
  onSend(text: string, opts?: { attachments?: string[] }): Promise<void>;
  /** B12: whether the orchestrator takes images (`false` is said as soon as one is attached). */
  acceptsImages?: boolean | null | undefined;
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
  /** Decision 96: the main session it sends to (parallel sessions); absent before them. */
  session?: ComposerSession | null | undefined;
};

const noCount = () => undefined;

/** P2-6: the size check's own chunk, loaded once a text could be near the body limit. */
const loadSizer = () => import("../../lib/messageSize");

type MenuState = { mode: "button" } | { mode: "inline"; start: number; query: string };

/**
 * The composer (decision 62): one container (radius 14, raised, hairline that brightens on focus;
 * no glow, decision 87). Inside: the pills (queued messages, line comments, attached files), the text area
 * (1–10 lines), and the control row — "+", the model / folder / tier chips (labels shed by container width,
 * round 3: narrow: mode, then model, then folder), the context ring and one round button that is Send, Stop, or Queue.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, handle) {
  const { text, setText, area, place } = useComposerText(props.draft);
  const pics = useImages();
  const attach = useAttachments(pics.add);
  const host = useHost();
  const picker = useRef<FileInputHandle>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorFields, setErrorFields] = useState<ReturnType<typeof structuredError>>(null);
  const [sending, setSending] = useState(false);
  // A9: a send still unanswered after a moment says so; the bridge times it out (then the notice below offers Retry).
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<{ model: string; message: string; provider?: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [chipOpen, setChipOpen] = useState(0);
  const box = useRef<HTMLFormElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<ComposerMenuHandle>(null);
  const slashRef = useRef<SlashMenuHandle>(null);
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashActive, setSlashActive] = useState<string | null>(null);
  const [modelRequest, setModelRequest] = useState<{ n: number; query: string } | undefined>(undefined);
  const slashCommands = useSlashCommands();
  const openModel = useCallback((query: string) => setModelRequest((r) => ({ n: (r?.n ?? 0) + 1, query })), []);
  const runSlash = useSlashRunner({ mode: props.mode, openModel });
  const slashListId = useId();
  const listId = useId();
  const slots = useChatSlots();
  const phone = usePhone();
  // G5: Stop answers at once ("Stopping…", here and on the turn's live row) and says what is true if the turn takes long.
  const ownKey = useId();
  const stopKey = useOptionalWorkspace()?.projectId ?? ownKey;
  const stopping = useStopping(stopKey, props.running);
  const [lateFor, setLateFor] = useState<number | null>(null);
  useEffect(() => {
    if (stopping === null) return;
    const t = window.setTimeout(() => setLateFor(stopping), Math.max(0, stopping + STILL_STOPPING_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [stopping]);
  const stillStopping = stopping !== null && lateFor === stopping;
  const stop = () => {
    if (stopping !== null) return;
    markStopping(stopKey);
    // A refused cancel gives the button back (the turn still runs; pressing again asks again).
    props.onCancel().catch(() => clearStopping(stopKey));
  };

  const modeChoose = props.mode?.choose;
  useImperativeHandle(
    handle,
    () => ({
      focus: () => area.current?.focus(),
      fill: (value) => place(value),
      addFiles: (files) => attach.add(files),
      refinePlan: () => {
        modeChoose?.("plan");
        area.current?.focus();
      },
    }),
    [area, place, modeChoose, attach],
  );

  const overlay = menu !== null || slash !== null || commentsOpen || chipOpen > 0;
  const onOverlay = props.onOverlay;
  useEffect(() => onOverlay?.(overlay), [overlay, onOverlay]);
  useEffect(() => () => onOverlay?.(false), [onOverlay]);
  const onChip = useCallback((open: boolean) => setChipOpen((n) => Math.max(0, n + (open ? 1 : -1))), []);

  const disabled = props.disabledReason !== null;
  const pendingComments = props.comments?.count ?? 0;
  const hasContent = text.trim().length > 0 || attach.files.length > 0 || pics.images.length > 0 || pendingComments > 0;
  const canSend = !disabled && !sending && !pics.busy && hasContent;
  // P2-6: the harness refuses a body over 1 MiB; the size shows near the limit and a longer message is not sent.
  // Counted in a deferred render, off the keystroke (a pass over a 2.4 MB text is ~20 ms).
  const sizedText = useDeferredValue(text);
  const large = mayNearLimit(sizedText);
  const [sizer, setSizer] = useState<typeof SizeModule | null>(null);
  useEffect(() => {
    // A failed load leaves no counter; the harness still refuses the body itself.
    if (large && !sizer) void loadSizer().then(setSizer, () => undefined);
  }, [large, sizer]);
  const size = useMemo(() => (large && sizer ? sizer.messageSize(sizedText) : null), [large, sizer, sizedText]);
  // Set before a paste that brings one goes in (the browser lays the text out once while inserting it): see `plainShaping`.
  const [pastingLong, setPastingLong] = useState(false);
  const plainText = useMemo(() => plainShaping(text), [text]);
  const longWord = plainText || pastingLong;
  /** The refusal of a message too long to send (until the text is edited). */
  const [refused, setRefused] = useState<string | null>(null);

  const outgoing = () => withAttachments(text.trim(), attach.files);
  const queue = () => {
    const message = outgoing();
    if (!message || disabled) return;
    props.queue.add(message);
    setText("");
    attach.clear();
    pics.clear();
  };
  const submit = async () => {
    if (!canSend) return;
    // An Octo command typed out in full runs here; an agent's is sent as typed (B11).
    const octo = octoCommandFor(text, slashCommands);
    if (octo && attach.files.length === 0) {
      setText("");
      setSlash(null);
      await runSlash(octo.command.name, octo.args);
      return;
    }
    // P2-6: a message over the harness's body limit is not sent (a short one never waits for the check).
    const message = outgoing();
    const check = mayNearLimit(message) ? await loadSizer().catch(() => null) : null;
    const big = check?.messageSize(message);
    setRefused(check && big?.over ? check.tooLongText(big.bytes) : null);
    if (big?.over) return;
    if (props.running && !props.serverQueue) return queue();
    setSending(true);
    // Cleared when the send settles, which the bridge's send timeout bounds.
    const timer = window.setTimeout(() => setSlow(true), SENDING_NOTICE_MS);
    setError(null);
    setErrorCode(null);
    setErrorFields(null);
    try {
      // Images only: the harness wants some text with them.
      const body = outgoing() || (pics.ready.length ? "See the attached image." : "");
      await props.onSend(body, pics.ready.length ? { attachments: pics.ready } : undefined);
      setText("");
      attach.clear();
      pics.clear();
    } catch (e) {
      // The draft stays in the box (and the chips on the row) so the person can fix it and send again.
      setError(errorMessage(e));
      setErrorCode(errorCodeOf(e));
      setErrorFields(structuredError(e));
    } finally {
      window.clearTimeout(timer);
      setSending(false);
      setSlow(false);
    }
  };

  /** Re-reads the word at the caret: opens, updates or closes the inline menu. */
  const syncTrigger = (value: string, caret: number) => {
    const q = slashQuery(value, caret);
    setSlash(q === null ? null : { query: q });
    if (q !== null) {
      setMenu(null);
      return;
    }
    // Only the words before the caret are read (P1-5: a pasted megabyte must not be scanned on every keystroke).
    const at = triggerAt(value, caret);
    if (at) setMenu({ mode: "inline", ...at });
    else setMenu((cur) => (cur?.mode === "inline" ? null : cur));
  };
  // Closing the button-opened menu gives focus back: Esc to the "+" that opened it (decision 95 b), a pick or a click to the text.
  const closeMenu = useCallback(
    (reason?: "escape") => {
      setMenu((cur) => {
        if (cur?.mode === "button") requestAnimationFrame(() => (reason === "escape" ? plus : area).current?.focus());
        return null;
      });
    },
    [area, plus],
  );
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

  const chooseSlash = (row: SlashRow) => {
    setSlash(null);
    // A command that takes an argument, and every agent command, goes into the text to be completed; the rest run now.
    if (row.group === "agent" || row.args) {
      place(`/${row.name} `);
      return;
    }
    setText("");
    void runSlash(row.name, "");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && slashRef.current?.onKeyDown(e)) {
      e.preventDefault();
      if (e.key === "Escape") setSlash(null);
      return;
    }
    if (menu?.mode === "inline" && menuRef.current?.onKeyDown(e)) {
      e.preventDefault();
      return;
    }
    // Shift+Tab cycles the mode while the text has focus (parity B3); with the inline menu open Tab belongs to the menu.
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && props.mode) {
      e.preventDefault();
      props.mode.cycle();
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
      stop();
    }
  };

  const model = props.model;
  const chooseModel = (next: string, force?: boolean) => {
    if (!model) return;
    setModelError(null);
    model.choose(next, force).catch((e: unknown) => {
      const provider = canForce(e) ? refusedProvider(e) : undefined;
      setModelError({ model: next, message: errorMessage(e), ...(provider ? { provider } : {}) });
    });
  };
  const inlineOpen = menu?.mode === "inline";
  const pickImage = () => {
    if (host.pickImages) void host.pickImages().then(pics.add, () => undefined);
    else picker.current?.open();
  };
  const agentName = useAgentName(model?.value);
  const action = props.running ? (hasContent ? "queue" : "stop") : "send";
  // The mode, model and folder chips: on the control row, and (direction 7, phone) in the "+" menu, which shows them there only.
  const chips = (
    <>
      {props.mode && (
        <Suspense fallback={<span aria-hidden className="size-7 shrink-0" />}>
          <ModeChip
            value={props.mode.value}
            isDefault={props.mode.isDefault}
            onChoose={props.mode.choose}
            onMakeDefault={() => void props.mode?.makeDefault().catch(() => undefined)}
            bare={false}
            disabled={disabled}
            onOpenChange={onChip}
          />
        </Suspense>
      )}
      {model && (
        <ModelChip
          value={model.value}
          title={model.title}
          unavailable={model.unavailable === true}
          onChoose={chooseModel}
          onChooseUnverified={(value) => chooseModel(value, true)}
          openRequest={modelRequest}
          footer={
            props.tier ? (
              <Suspense fallback={null}>
                <RoutingLine value={props.tier.value} onChoose={(p) => void props.tier?.choose(p).catch(() => undefined)} />
              </Suspense>
            ) : undefined
          }
          bare={false}
          disabled={disabled}
          onOpenChange={onChip}
        />
      )}
      <FolderChip folders={props.folders} onAdd={props.onAddFolder} bare={false} disabled={disabled} onOpenChange={onChip} />
    </>
  );

  return (
    <div data-composer-wrap>
      {error && (
        <Suspense fallback={null}>
          <ErrorNotice
            fields={errorFields}
            raw={error}
            code={errorCode}
            agent={agentName}
            className="mb-2"
            onRetry={() => void submit()}
            retrying={sending}
            {...(errorCode === "images_unsupported"
              ? {
                  actions: (
                    <Button size="sm" variant="quiet" onClick={pics.clear}>
                      Remove the images
                    </Button>
                  ),
                }
              : {})}
          />
        </Suspense>
      )}
      {refused !== null && (
        <Suspense fallback={null}>
          <ErrorNotice fields={{ message: refused }} className="mb-2" data="too-long" />
        </Suspense>
      )}
      {props.acceptsImages === false && pics.images.length > 0 && !error && (
        <p data-images-unsupported className="mb-2 px-3 text-sm text-fg-3">
          {agentName ?? "This model"} can&apos;t read images, so it would ignore these. Remove them or choose another model.
        </p>
      )}
      {pics.note && (
        <Notice>
          <span className="text-fg-2">{pics.note}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={pics.dismissNote}>
            Dismiss
          </Button>
        </Notice>
      )}
      {modelError && (
        <Notice>
          <span className="text-err">Couldn't switch the model.</span> {modelError.message.replace(/\.$/, "")}. The orchestrator keeps its previous one.
          {modelError.provider ? (
            <Suspense fallback={null}>
              <ModelRefusedActions
                provider={modelError.provider}
                onRetry={() => chooseModel(modelError.model)}
                onForce={() => chooseModel(modelError.model, true)}
              />
            </Suspense>
          ) : (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => chooseModel(modelError.model)}>
              Retry
            </Button>
          )}
        </Notice>
      )}
      {props.notice && (
        <p className="mb-2 px-3 text-sm text-fg-3" title={props.notice.title}>
          {props.notice.text}
        </p>
      )}
      {stillStopping && (
        <p role="status" data-still-stopping className="octo-fade mb-2 px-3 text-sm text-fg-3">
          Still stopping — a running command has to finish
        </p>
      )}
      {props.mode && modeNote(props.mode.value) && <p className="mb-2 px-3 text-sm text-fg-3">{modeNote(props.mode.value)}</p>}
      {attach.note && (
        <Notice>
          <span className="text-fg-2">{attach.note}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={attach.dismissNote}>
            Dismiss
          </Button>
        </Notice>
      )}
      <div className="relative">
        {slash && (
          <Suspense fallback={null}>
            <SlashMenu
              ref={slashRef}
              box={box}
              commands={slashCommands}
              query={slash.query}
              listId={slashListId}
              onActive={setSlashActive}
              onChoose={chooseSlash}
              onClose={() => setSlash(null)}
            />
          </Suspense>
        )}
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
            // A click on the container's padding (or the text box's fixed top padding) still puts the caret in the text.
            if (e.target === e.currentTarget || (e.target instanceof HTMLElement && e.target.hasAttribute("data-composer-pad"))) {
              e.preventDefault();
              area.current?.focus();
            }
          }}
          {...attach.dropProps}
          className={cn("octo-composer @container/composer relative isolate flex flex-col bg-raised", disabled && "opacity-80")}
        >
          {props.session && (
            // A narrow composer (beside a panel) has no room for the session chip in the control row: there it keeps a line of its
            // own at the top of the box (styles.css shows one of the two places, never both).
            <div data-composer-session="top" className="flex min-w-0 px-1.5 pt-1.5">
              <Suspense fallback={<span aria-hidden className="h-ctl-sm" />}>
                <SessionChip session={props.session} bare={false} disabled={false} onOpenChange={onChip} />
              </Suspense>
            </div>
          )}
          {slots?.queue?.({ onCount: noCount })}
          {(pics.images.length > 0 || attach.files.length > 0 || props.queue.items.length > 0 || pendingComments > 0) && (
            <Suspense fallback={null}>
              <ComposerPills
                images={pics.images}
                onRemoveImage={pics.remove}
                files={attach.files}
                onRemoveFile={attach.remove}
                queue={props.queue.items}
                onUnqueue={props.queue.remove}
                comments={pendingComments > 0 ? props.comments?.render(commentsOpen, setCommentsOpen) : null}
              />
            </Suspense>
          )}
          <label htmlFor={props.floating ? "octo-composer-float" : "octo-composer"} className="sr-only">
            Message the orchestrator
          </label>
          {/* C6: the top padding sits outside the scrolling text, so a long prompt never scrolls it away. */}
          <div data-composer-pad className="relative pt-3">
            <Suspense fallback={null}>
              <ComposerHighlight text={text} area={area} />
            </Suspense>
            <textarea
              id={props.floating ? "octo-composer-float" : "octo-composer"}
              ref={area}
              rows={1}
              value={text}
              data-long-word={longWord || undefined}
              disabled={disabled}
              onChange={(e) => {
                setText(e.target.value);
                setRefused(null);
                setPastingLong(false);
                syncTrigger(e.target.value, e.target.selectionStart);
              }}
              onSelect={(e) => inlineOpen && syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                if (!longWord && plainShaping(e.clipboardData.getData("text/plain"))) flushSync(() => setPastingLong(true));
                attach.onPaste(e);
              }}
              onBlur={() => {
                if (inlineOpen) setMenu(null);
                setSlash(null);
              }}
              placeholder={props.disabledReason ?? (phone ? "Ask anything" : "Ask anything, @ to mention a file")}
              aria-autocomplete="list"
              aria-expanded={inlineOpen || slash !== null}
              aria-controls={slash ? slashListId : inlineOpen ? listId : undefined}
              aria-activedescendant={slash ? (slashActive ?? undefined) : inlineOpen && activeOption ? activeOption : undefined}
              aria-keyshortcuts="Enter Shift+Enter Control+Enter Escape"
              className="octo-composer-input relative block w-full resize-none overscroll-contain bg-transparent px-3 wrap-anywhere text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
            />
          </div>
          <div data-composer-row className="flex h-10 min-w-0 items-center gap-1 px-1.5 pb-1.5">
            <IconButton
              ref={plus}
              icon={Plus}
              label="Attach, mention or run"
              title="Attach a file, mention, or run an action ( / or @ )"
              aria-haspopup="listbox"
              aria-expanded={menu?.mode === "button"}
              pressed={menu?.mode === "button"}
              disabled={disabled}
              onClick={() => setMenu((m) => (m?.mode === "button" ? null : { mode: "button" }))}
            />
            {chips}
            {props.session && (
              // Balance pass: the session the composer sends to is the last chip of the control row (it was a line of its own at
              // the top of the box). It takes the row's free room (the spacer gives way, styles.css), so it is the one to shorten.
              <span data-composer-session="row" className="flex min-w-0 flex-1">
                <Suspense fallback={<span aria-hidden className="h-ctl-sm" />}>
                  <SessionChip session={props.session} bare={false} disabled={false} onOpenChange={onChip} />
                </Suspense>
              </span>
            )}
            <span data-composer-spacer className="min-w-0 flex-1" />
            {props.context.used && props.context.size ? (
              <Suspense fallback={null}>
                <ContextRing used={props.context.used} size={props.context.size} />
              </Suspense>
            ) : null}
            {size?.near && (
              <span data-composer-size data-over={size.over || undefined} className={cn("px-1 text-xs tabular-nums", size.over ? "text-err" : "text-fg-3")}>
                {size.label}
              </span>
            )}
            {slow && (
              <span role="status" className="px-1 text-xs text-fg-3">
                Sending…
              </span>
            )}
            {stopping !== null && action === "stop" && (
              <span role="status" className="px-1 text-xs text-fg-3">
                Stopping…
              </span>
            )}
            {/* Remote access: no Send (or Stop) on a device that may not use it; the field says why, this says where it changes. */}
            {deviceMay(host.remoteDevice, action === "stop" ? "stop" : "send") ? (
              <SendButton
                action={action}
                stopping={stopping !== null}
                enabled={action === "stop" ? !disabled && stopping === null : canSend && !size?.over}
                onStop={stop}
              />
            ) : (
              <span data-composer-note className="shrink-0 px-1 text-xs text-fg-3">
                {ON_YOUR_COMPUTER}
              </span>
            )}
          </div>
        </form>
      </div>
      <Suspense fallback={null}>
        <FileInput ref={picker} label="Attach images" accept="image/png,image/jpeg,image/webp,image/gif,image/*" multiple onFiles={pics.add} />
      </Suspense>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Suspense fallback={null}>
            <ComposerMenu
              ref={menuRef}
              anchor={menu.mode === "button" ? plus : box}
              box={box}
              query={menu.mode === "inline" ? menu.query : null}
              listId={listId}
              onActive={setActiveOption}
              pendingComments={pendingComments}
              onOpenComments={openComments}
              onPickImage={pickImage}
              onPick={pick}
              onClose={closeMenu}
              chips={chips}
            />
          </Suspense>
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
const STOPPING_LABEL = "Stopping… the turn ends once its current step does";

/** One 28px round button: Send (dim while empty), Stop while working, Queue while working with text (decision 62). */
function SendButton({ action, enabled, stopping, onStop }: { action: "send" | "queue" | "stop"; enabled: boolean; stopping: boolean; onStop(): void }) {
  const { icon } = SEND[action];
  const label = action === "stop" && stopping ? STOPPING_LABEL : SEND[action].label;
  const solid = enabled && action !== "stop";
  return (
    <IconButton
      icon={icon}
      label={label}
      round
      variant={solid ? "primary" : "quiet"}
      type={action === "stop" ? "button" : "submit"}
      onClick={action === "stop" ? onStop : undefined}
      disabled={!enabled}
      data-action={action}
      data-stopping={(action === "stop" && stopping) || undefined}
      className={cn(!solid && action === "stop" && !stopping && "bg-active text-fg")}
    />
  );
}
