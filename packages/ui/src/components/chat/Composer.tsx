import type { Folder } from "@octo/agent-client";
import { ArrowUp, Square } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
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
  /** Keeps an unsent draft across remounts (moving the Chat tab to another group). */
  draft?: { initial: string; save(text: string): void };
  /** Pending code comments go out with the next message (which may then have no text). */
  comments?: { count: number; control: ReactNode };
  /** Floating over a file view: a shadow instead of the hairline, no folder line. */
  floating?: boolean;
};

const MAX_HEIGHT_VH = 0.4;

/**
 * A tall rounded box (radius 12, 8px inset): the text area on top, a control row inside at the bottom
 * (left: pending comments, the orchestrator model; right: send / stop). Text and control labels start
 * on one line 16px in (box 8 + control 8). Folder names follow as one quiet line below the box.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, handle) {
  const [text, setText] = useState(() => props.draft?.initial ?? "");
  const saveDraft = props.draft?.save;
  useEffect(() => {
    saveDraft?.(text);
  }, [text, saveDraft]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<{ model: string; message: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          "flex flex-col rounded-xl border bg-raised p-2 transition-[border-color] duration-100",
          props.floating ? "border-transparent shadow-float" : "border-line",
          !disabled && "focus-within:border-focus",
        )}
        onMouseDown={(e) => {
          // Clicking the padding around the textarea still puts the caret in it.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            area.current?.focus();
          }
        }}
      >
        <label htmlFor={props.floating ? "octo-composer-float" : "octo-composer"} className="sr-only">
          Message the orchestrator
        </label>
        <textarea
          id={props.floating ? "octo-composer-float" : "octo-composer"}
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="block max-h-[40vh] min-w-0 resize-none overscroll-contain bg-transparent px-2 py-1.5 text-base wrap-anywhere text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
        />
        <div className="mt-1 flex h-row items-center gap-1">
          {pendingComments > 0 && props.comments?.control}
          {model && <ModelSelect value={model.value} options={model.options} onChoose={chooseModel} disabled={disabled} />}
          <span className="flex-1" />
          {props.running ? (
            <button
              type="button"
              onClick={() => void props.onCancel()}
              aria-label="Stop the current turn"
              title="Stop"
              // Radius 4 = box 12 − inset 8.
              className="press grid size-7 shrink-0 place-items-center rounded-xs bg-primary text-primary-fg hover:opacity-90"
            >
              <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send"
              className="press grid size-7 shrink-0 place-items-center rounded-xs bg-primary text-primary-fg hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100"
            >
              <ArrowUp size={16} strokeWidth={2} absoluteStrokeWidth aria-hidden />
            </button>
          )}
        </div>
      </form>
      {!props.floating && (
        <p className="mt-2 h-4 truncate px-4 text-xs text-fg-3" title={props.folders.map((f) => f.path).join("\n") || undefined}>
          {folders || "No folders attached"}
        </p>
      )}
    </div>
  );
});
