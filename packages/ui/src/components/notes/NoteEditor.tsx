import { NOTE_LIMITS, type Note, type NoteDocument, type NoteInput } from "@octo/agent-client";
import { useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { DETAIL_COLUMN } from "../../lib/panelColumn";
import { useBlockFloating } from "../../state/workspace/useFloatingHere";
import { charCount, autoDescription, parseTags, pinState } from "../../lib/notes";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Field } from "../primitives/Field";
import { Notice } from "../primitives/Notice";
import { DetailHeader, FormActions } from "../primitives/Panel";
import { Segmented } from "../primitives/Segmented";
import { TextArea, TextField } from "../primitives/TextField";
import { Markdown } from "../shared/Markdown";

type View = "write" | "preview";

/**
 * The note form: title, a description agents see in the index, tags, the Markdown body (source, or a rendered preview)
 * and the pin with its limits explained. Saves the fields; the harness keeps the front matter. It opens under a
 * `DetailHeader` like every detail (Back in one column) and ends with the one action row (P2, B35).
 */
export function NoteEditor(props: { note?: NoteDocument; notes: readonly Note[]; onCancel(): void; onSave(input: NoteInput): Promise<void> }) {
  const { note } = props;
  useBlockFloating();
  const [title, setTitle] = useState(note?.title ?? "");
  const [description, setDescription] = useState(note && !note.description_auto ? note.description : "");
  const [tags, setTags] = useState(note?.tags.join(", ") ?? "");
  const [body, setBody] = useState(note?.content ?? "");
  const [pinned, setPinned] = useState(note?.pinned ?? false);
  const [view, setView] = useState<View>("write");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [discarding, setDiscarding] = useState(false);
  const lastField = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const dirty =
    title !== (note?.title ?? "") ||
    description !== (note && !note.description_auto ? note.description : "") ||
    tags !== (note?.tags.join(", ") ?? "") ||
    body !== (note?.content ?? "") ||
    pinned !== (note?.pinned ?? false);
  // Esc and Cancel close at once when nothing changed; otherwise they ask first, in the action row.
  const cancel = () => {
    if (!dirty) return props.onCancel();
    setDiscarding(true);
    requestAnimationFrame(() => keepRef.current?.focus());
  };
  const keepEditing = () => {
    setDiscarding(false);
    requestAnimationFrame(() => (lastField.current?.isConnected ? lastField.current : titleRef.current)?.focus());
  };

  const derived = autoDescription(body);
  const length = charCount(description);
  const tooLong = length > NOTE_LIMITS.description;
  const pin = pinState(props.notes, note ? { id: note.id, size: charCount(body) } : { size: charCount(body) });
  const pinBlocked = pinned && !pin.canPin;
  const titleError = submitted && !title.trim() ? "Give the note a title." : null;
  const bodyError = submitted && !body.trim() ? "Write what should be remembered." : null;

  const save = async () => {
    setSubmitted(true);
    if (!title.trim()) return titleRef.current?.focus();
    if (!body.trim()) {
      setView("write");
      return bodyRef.current?.focus();
    }
    if (tooLong || pinBlocked) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ title: title.trim(), description: description.trim(), tags: parseTags(tags), pinned, content: body });
    } catch (e) {
      setError(`Couldn't save the note: ${errorMessage(e)}. Try again.`);
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      aria-label={note ? `Edit ${note.title}` : "New note"}
      className={cn("flex flex-col gap-4 pb-4", DETAIL_COLUMN)}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onFocus={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) lastField.current = e.target;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (discarding) keepEditing();
          else cancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
      }}
    >
      <DetailHeader title={note ? note.title : "New note"} {...(note ? { meta: "Editing" } : {})} />
      <div className="flex flex-col gap-4 px-2">
        <Field label="Title" htmlFor={`${id}-title`} error={titleError} errorId={`${id}-title-error`}>
          <TextField
            id={`${id}-title`}
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? `${id}-title-error` : undefined}
            autoFocus
          />
        </Field>
        <Field
          label="Description"
          htmlFor={`${id}-desc`}
          hint={
            <>
              Agents see this line and open the note only when it is relevant.
              {description.trim() === "" && derived !== "" && <> Left empty, it is taken from the first line.</>}
            </>
          }
          error={tooLong ? `Shorten the description by ${length - NOTE_LIMITS.description} characters.` : null}
          errorId={`${id}-desc-error`}
        >
          <div className="relative">
            <TextField
              id={`${id}-desc`}
              value={description}
              placeholder={derived}
              onChange={(e) => setDescription(e.target.value.replace(/\n/g, " "))}
              aria-invalid={tooLong ? true : undefined}
              aria-describedby={tooLong ? `${id}-desc-error` : undefined}
              className="pr-16"
            />
            <span aria-live="off" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-fg-3 tabular-nums">
              {length}/{NOTE_LIMITS.description}
            </span>
          </div>
        </Field>
        <Field label="Tags" htmlFor={`${id}-tags`} optional>
          <TextField id={`${id}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="deploy, rules" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="flex min-h-ctl-xs items-center justify-between gap-2">
            <label htmlFor={`${id}-body`} className="text-sm text-fg-2">
              Note (Markdown)
            </label>
            <Segmented<View>
              label="Note view"
              options={[
                { id: "write", label: "Source" },
                { id: "preview", label: "Preview" },
              ]}
              value={view}
              onChange={setView}
            />
          </div>
          {view === "write" ? (
            <TextArea
              id={`${id}-body`}
              ref={bodyRef}
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              className="font-mono text-xs"
              aria-invalid={bodyError ? true : undefined}
              aria-describedby={bodyError ? `${id}-body-error` : undefined}
            />
          ) : (
            <div className="min-h-[12rem] rounded-md border border-field-edge bg-panel px-3 py-2">
              {body.trim() ? <Markdown text={body} className="octo-prose octo-prose-sm" /> : <p className="text-sm text-fg-3">Nothing to preview yet.</p>}
            </div>
          )}
          {bodyError && (
            <div id={`${id}-body-error`}>
              <Notice tone="error">{bodyError}</Notice>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Checkbox checked={pinned} onChange={setPinned} label="Pin this note" />
          {pinBlocked ? (
            <Notice tone="error">{pin.reason}</Notice>
          ) : (
            <p className="text-xs text-fg-3">
              {`Pinned notes go to agents in full with every request. Use them for rules that always apply (up to ${NOTE_LIMITS.pinned} notes, ${NOTE_LIMITS.pinnedChars.toLocaleString("en-US")} characters in total).`}
            </p>
          )}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {discarding ? (
          <FormActions key="discard" note="Discard changes?" label="Discard changes">
            <Button size="sm" variant="quiet" ref={keepRef} onClick={keepEditing}>
              Keep editing
            </Button>
            <Button size="sm" variant="danger" onClick={props.onCancel}>
              Discard
            </Button>
          </FormActions>
        ) : (
          <FormActions key="actions">
            <Button size="sm" variant="quiet" onClick={cancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={busy}>
              {note ? "Save" : "Add note"}
            </Button>
          </FormActions>
        )}
      </div>
    </form>
  );
}
