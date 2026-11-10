import type { Folder } from "@octo/agent-client";
import { ArrowUp, Square } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
import { modelLabel } from "../primitives/Status";

export type ComposerHandle = { focus(): void; fill(text: string): void };

type Props = {
  running: boolean;
  disabledReason: string | null;
  /** The conversation already has messages: the placeholder invites a follow-up. */
  followUp: boolean;
  folders: Folder[];
  model: string | null;
  onSend(text: string): Promise<void>;
  onCancel(): Promise<void>;
  /** Keeps an unsent draft across remounts (moving the Chat tab to another group). */
  draft?: { initial: string; save(text: string): void };
};

const MAX_HEIGHT_VH = 0.4;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, handle) {
  const [text, setText] = useState(() => props.draft?.initial ?? "");
  const saveDraft = props.draft?.save;
  useEffect(() => {
    saveDraft?.(text);
  }, [text, saveDraft]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const canSend = !disabled && !props.running && !sending && text.trim().length > 0;

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

  const placeholder = disabled ? props.disabledReason! : props.followUp ? "Send follow-up" : "Message the orchestrator";
  const folders = props.folders.map((f) => f.label).join(", ");

  return (
    <div>
      {error && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm">
          <p className="min-w-0 flex-1 text-fg-2">
            <span className="text-err">Couldn't send.</span> {error.replace(/\.$/, "")}. Your message is still in the box.
          </p>
          <Button size="sm" onClick={() => void submit()} disabled={!canSend}>
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
          "flex items-end gap-2 rounded-xl border border-line bg-raised pr-1.5 pl-3.5 transition-[border-color] duration-100",
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
        <label htmlFor="octo-composer" className="sr-only">
          Message the orchestrator
        </label>
        <textarea
          id="octo-composer"
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="block max-h-[40vh] min-h-10 min-w-0 flex-1 resize-none overscroll-contain bg-transparent py-[9px] text-base leading-[22px] wrap-anywhere text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
        />
        {props.running ? (
          <button
            type="button"
            onClick={() => void props.onCancel()}
            aria-label="Stop the current turn"
            title="Stop"
            className="press mb-1.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg hover:opacity-90"
          >
            <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
            className="press mb-1.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100"
          >
            <ArrowUp size={15} strokeWidth={2} absoluteStrokeWidth aria-hidden />
          </button>
        )}
      </form>
      {/* Footer: context on the left (folders; pending comments will join it), the model on the right. */}
      <div className="mt-1.5 flex h-4 items-center gap-3 px-1 text-xs text-fg-3">
        <p className="min-w-0 flex-1 truncate" title={props.folders.map((f) => f.path).join("\n") || undefined}>
          {folders || "No folders attached"}
        </p>
        {props.model && (
          <p className="shrink-0" title={`Orchestrator model: ${props.model}`}>
            {modelLabel(props.model)}
          </p>
        )}
      </div>
    </div>
  );
});
