import type { Folder } from "@octo/agent-client";
import { ArrowUp, Folder as FolderIcon, Square } from "lucide-react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { shortModel } from "../primitives/Status";

export type ComposerHandle = { focus(): void; fill(text: string): void };

type Props = {
  running: boolean;
  disabledReason: string | null;
  folders: Folder[];
  model: string | null;
  onSend(text: string): Promise<void>;
  onCancel(): Promise<void>;
};

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

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

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

  const placeholder = disabled
    ? props.disabledReason!
    : props.running
      ? "The orchestrator is working — you can draft your next message"
      : "Message the orchestrator";

  return (
    <div className="mx-auto w-full max-w-measure">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          "rounded-lg border bg-raised transition-[border-color,box-shadow]",
          disabled
            ? "border-line"
            : "border-line-strong focus-within:border-[color-mix(in_oklch,var(--octo-accent)_55%,transparent)] focus-within:ring-[3px] focus-within:ring-accent-soft",
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
          className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-6 text-fg placeholder:text-fg-3 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2 py-2 pr-2 pl-3">
          <ContextLine folders={props.folders} model={props.model} />
          {props.running ? (
            <button
              type="button"
              onClick={() => void props.onCancel()}
              aria-label="Stop the current turn"
              title="Stop"
              className="ml-auto grid size-7 shrink-0 place-items-center rounded-md bg-fg text-bg transition-opacity hover:opacity-85"
            >
              <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send (Enter)"
              className="ml-auto grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg transition-colors hover:bg-accent-strong disabled:bg-active disabled:text-fg-3"
            >
              <ArrowUp size={15} strokeWidth={2.25} aria-hidden />
            </button>
          )}
        </div>
      </form>
      <p role={error ? "alert" : undefined} className={cn("mt-1.5 mb-2 h-4 px-1 text-2xs", error ? "text-err" : "text-fg-3")}>
        {error ?? (disabled ? "" : "Enter to send · Shift+Enter for a new line")}
      </p>
    </div>
  );
});

function ContextLine({ folders, model }: { folders: Folder[]; model: string | null }) {
  const shown = folders.slice(0, 3);
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-fg-3">
      {shown.map((f) => (
        <span
          key={f.id}
          title={f.path}
          className="inline-flex h-5 max-w-[160px] min-w-0 items-center gap-1 rounded-xs border border-line px-1.5"
        >
          <FolderIcon size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="truncate">{f.label}</span>
        </span>
      ))}
      {folders.length > shown.length && <span>+{folders.length - shown.length}</span>}
      {folders.length === 0 && <span>No folders attached</span>}
      {model && (
        <>
          <span aria-hidden className="text-line-strong">
            ·
          </span>
          <span className="truncate" title={model}>
            {shortModel(model)}
          </span>
        </>
      )}
    </div>
  );
}
