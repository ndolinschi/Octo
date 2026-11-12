import { useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { MOD_LABEL } from "../../lib/keys";
import { Button } from "../primitives/Button";
import { Textarea } from "../primitives/Field";
import { Spinner } from "../primitives/Status";

export type ComposerValue = { body: string; suggestion: string | undefined };

function focusMount(el: HTMLElement | null): void {
  el?.focus();
}

/**
 * The box a comment is written in, docked under the diff (not floated over it, so it never covers the code it is about).
 * A suggestion adds a second editor prefilled with the commented lines; the reader edits them into the replacement.
 * `onSave` returns the error to show inline, or null when it saved.
 */
export function Composer(props: {
  heading: string;
  /** The lines a suggestion replaces ("lines 12–14"); absent: this comment cannot carry a suggestion. */
  suggestFor?: string;
  initialBody: string;
  /** Text to prefill the suggestion with; defined means the suggestion is on. */
  initialSuggestion: string | undefined;
  /** The text of the lines, used when the reader turns the suggestion on later. */
  linesText: string;
  saveLabel: string;
  onSave(value: ComposerValue): Promise<string | null>;
  onCancel(): void;
}) {
  const [body, setBody] = useState(props.initialBody);
  const [suggest, setSuggest] = useState(props.initialSuggestion !== undefined);
  const [suggestion, setSuggestion] = useState(props.initialSuggestion ?? props.linesText);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    if (!body.trim()) {
      setError("Write something before adding the comment.");
      return;
    }
    setBusy(true);
    setError(null);
    const problem = await props.onSave({ body: body.trim(), suggestion: suggest ? suggestion : undefined });
    setBusy(false);
    if (problem) setError(problem);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <form
      aria-label={props.heading}
      className="flex max-h-[60%] shrink-0 flex-col gap-2 overflow-y-auto border-t border-line bg-raised p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="min-w-0 truncate text-sm font-medium text-fg">{props.heading}</h3>
        {props.suggestFor !== undefined && (
          <label title="Suggest a change (S)" className="ml-auto flex h-6 cursor-pointer items-center gap-2 text-sm text-fg-2 max-sm:h-10">
            <input type="checkbox" className="size-4 accent-[var(--octo-primary)]" checked={suggest} onChange={(e) => setSuggest(e.target.checked)} />
            Suggest a change
          </label>
        )}
      </div>
      <Textarea
        ref={focusMount}
        aria-label="Comment"
        placeholder="Write a comment. It stays pending until you submit the review."
        rows={3}
        value={body}
        onKeyDown={onKeyDown}
        onChange={(e) => setBody(e.target.value)}
        className="max-sm:text-input-touch"
      />
      {suggest && props.suggestFor !== undefined && (
        <div className="flex flex-col gap-1">
          <label htmlFor="review-suggestion" className="text-xs text-fg-3">
            Replacement for {props.suggestFor}. Posted as a suggested change the author can apply.
          </label>
          <Textarea
            id="review-suggestion"
            rows={Math.min(6, Math.max(3, suggestion.split("\n").length))}
            spellCheck={false}
            value={suggestion}
            onKeyDown={onKeyDown}
            onChange={(e) => setSuggestion(e.target.value)}
            className={cn("bg-code-bg font-mono text-xs leading-5 whitespace-pre")}
            wrap="off"
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-err">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {busy && <Spinner />}
        <Button size="sm" variant="ghost" onClick={props.onCancel} className="max-sm:h-10">
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy} data-shortcut={`${MOD_LABEL}↵`} className="max-sm:h-10">
          {props.saveLabel}
        </Button>
      </div>
    </form>
  );
}
