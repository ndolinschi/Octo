import type { Folder } from "@octo/agent-client";
import { ArrowUp, Square } from "lucide-react";
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

  const placeholder = disabled ? props.disabledReason! : "Message the orchestrator";

  return (
    <div className="mx-auto w-full max-w-measure pb-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          "rounded-lg border bg-raised transition-[border-color] duration-100",
          disabled ? "border-line" : "border-line focus-within:border-line-strong",
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
          className="block max-h-[40vh] min-h-[40px] w-full resize-none bg-transparent px-3.5 pt-2.5 pb-0.5 text-base text-fg placeholder:text-fg-3 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex h-9 items-center gap-2 pr-1.5 pl-3.5">
          <ContextLine folders={props.folders} model={props.model} />
          {props.running ? (
            <button
              type="button"
              onClick={() => void props.onCancel()}
              aria-label="Stop the current turn"
              title="Stop"
              className="ml-auto grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-opacity duration-100 hover:opacity-90"
            >
              <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send"
              className="ml-auto grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-[background-color,color,opacity] duration-100 hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100"
            >
              <ArrowUp size={15} strokeWidth={2} absoluteStrokeWidth aria-hidden />
            </button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-1.5 px-1 text-xs text-err">
          {error}
        </p>
      )}
    </div>
  );
});

function ContextLine({ folders, model }: { folders: Folder[]; model: string | null }) {
  const names = folders.map((f) => f.label).join(", ");
  return (
    <p className="flex min-w-0 items-center gap-3 text-xs text-fg-3">
      {model && (
        <span className="shrink-0" title={model}>
          {shortModel(model)}
        </span>
      )}
      <span className="min-w-0 truncate" title={folders.map((f) => f.path).join("\n") || undefined}>
        {names || "No folders"}
      </span>
    </p>
  );
}
