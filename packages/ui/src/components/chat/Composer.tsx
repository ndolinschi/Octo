import type { Folder } from "@octo/agent-client";
import { ArrowUp, Square } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
import { shortModel } from "../primitives/Status";

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
};

const MAX_HEIGHT_VH = 0.4;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, handle) {
  const [text, setText] = useState("");
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
    <div className="mx-auto w-full max-w-measure pb-3">
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
          className="block max-h-[40vh] min-h-10 min-w-0 flex-1 resize-none bg-transparent py-[9px] text-base leading-[22px] text-fg placeholder:text-fg-3 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed"
        />
        {props.model && (
          <span className="mb-1.5 hidden h-7 shrink-0 items-center text-sm text-fg-3 min-[480px]:flex" title={props.model}>
            {shortModel(props.model)}
          </span>
        )}
        {props.running ? (
          <button
            type="button"
            onClick={() => void props.onCancel()}
            aria-label="Stop the current turn"
            title="Stop"
            className="mb-1.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-opacity duration-100 hover:opacity-90"
          >
            <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
            className="mb-1.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-[background-color,color,opacity] duration-100 hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100"
          >
            <ArrowUp size={15} strokeWidth={2} absoluteStrokeWidth aria-hidden />
          </button>
        )}
      </form>
      <p className="mt-1.5 truncate px-1 text-xs text-fg-3" title={props.folders.map((f) => f.path).join("\n") || undefined}>
        {folders || "No folders attached"}
      </p>
    </div>
  );
});
