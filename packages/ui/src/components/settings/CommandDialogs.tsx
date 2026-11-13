import { useId, useState } from "react";
import type { ProjectCommand, ReviewConfig } from "@octo/agent-client";
import { commandsProblem, parseGlobs } from "../../lib/commands/config";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Checkbox } from "../primitives/Checkbox";
import { Field } from "../primitives/Field";
import { FieldRow } from "../primitives/FieldRow";
import { Notice } from "../primitives/Notice";
import { Switch } from "../primitives/Switch";
import { TextArea, TextField } from "../primitives/TextField";

/** Add or edit one project command (decision 68). `others` are the rest of the list, so a clash or a third pin is named before saving. */
export function CommandDialog(props: {
  initial: ProjectCommand | null;
  others: readonly ProjectCommand[];
  onSave(c: ProjectCommand): Promise<string | null>;
  onRemove?: () => Promise<string | null>;
  onClose(): void;
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [command, setCommand] = useState(props.initial?.command ?? "");
  const [cwd, setCwd] = useState(props.initial?.cwd ?? "");
  const [pinned, setPinned] = useState(props.initial?.pinned === true);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const ids = [useId(), useId(), useId(), useId()] as const;
  const draft: ProjectCommand = { name: name.trim(), command: command.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(pinned ? { pinned: true } : {}) };
  const problem = name.trim() || command.trim() ? commandsProblem([...props.others, draft]) : null;
  const valid = name.trim() !== "" && command.trim() !== "" && problem === null;

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setServer(null);
    const p = await work();
    if (p) setServer(p);
    setBusy(false);
  };
  return (
    <Dialog
      title={props.initial ? "Edit command" : "Add a command"}
      description="Runs in a shell when you press its button, never by an agent."
      onClose={props.onClose}
      footer={
        <>
          {props.onRemove && (
            <Button variant="danger" disabled={busy} onClick={() => void run(props.onRemove ?? (async () => null))} className="mr-auto">
              Remove
            </Button>
          )}
          <Button variant="quiet" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void run(() => props.onSave(draft))}>
            Save
          </Button>
        </>
      }
    >
      <div className="@container flex flex-col gap-4">
        <FieldRow
          fields={[
            {
              id: ids[0],
              label: "Name",
              control: <TextField id={ids[0]} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tests" />,
            },
            {
              id: ids[2],
              label: "Folder (optional)",
              control: <TextField id={ids[2]} value={cwd} spellCheck={false} onChange={(e) => setCwd(e.target.value)} className="font-mono" />,
            },
          ]}
          hint="Folder: the project folder by default; a path inside it, or another folder's name."
        />
        <Field label="Command line" htmlFor={ids[1]}>
          <TextField
            id={ids[1]}
            value={command}
            spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="pnpm test"
            className="font-mono"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Switch id={ids[3]} label="Show as a button in the header" checked={pinned} onChange={setPinned} />
          <label htmlFor={ids[3]} className="text-sm text-fg-2">
            Show as a button in the header (two at most)
          </label>
        </div>
        {(problem || server) && <Notice tone="error">{server ?? problem}</Notice>}
      </div>
    </Dialog>
  );
}

/** Which commands a pull request offers: the names to tick, and what happens when none is ticked. */
export function OfferedDialog(props: {
  all: readonly ProjectCommand[];
  chosen: readonly string[];
  onSave(names: string[]): Promise<string | null>;
  onClose(): void;
}) {
  const [chosen, setChosen] = useState(() => new Set(props.chosen.map((n) => n.toLowerCase())));
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    const p = await props.onSave(props.all.filter((c) => chosen.has(c.name.toLowerCase())).map((c) => c.name));
    if (p) setServer(p);
    setBusy(false);
  };
  return (
    <Dialog
      title="Commands offered in a review"
      description="They appear under Run in a pull request's header and run in its own worktree. With none ticked, every command is offered."
      onClose={props.onClose}
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        {props.all.length === 0 && <p className="text-sm text-fg-3">This project has no commands yet. Add some first.</p>}
        {props.all.map((c) => (
          <Checkbox
            key={c.name}
            label={c.name}
            description={<span className="font-mono">{c.command}</span>}
            checked={chosen.has(c.name.toLowerCase())}
            onChange={(on) =>
              setChosen((s) => {
                const next = new Set(s);
                if (on) next.add(c.name.toLowerCase());
                else next.delete(c.name.toLowerCase());
                return next;
              })
            }
            className="py-1"
          />
        ))}
        {server && <Notice tone="error">{server}</Notice>}
      </div>
    </Dialog>
  );
}

/** Paths folded as mechanical in the reading order, one pattern per line. */
export function GlobsDialog(props: { initial: ReviewConfig["mechanical_globs"]; onSave(globs: string[]): Promise<string | null>; onClose(): void }) {
  const [text, setText] = useState(props.initial.join("\n"));
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const id = useId();
  const save = async () => {
    setBusy(true);
    const p = await props.onSave(parseGlobs(text));
    if (p) setServer(p);
    setBusy(false);
  };
  return (
    <Dialog
      title="Files folded as mechanical"
      description="One pattern per line. * stays inside a folder, ** crosses folders, no slash matches in any folder, a trailing slash is a folder. Lock files and generated files are always folded."
      onClose={props.onClose}
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Patterns" htmlFor={id}>
        <TextArea
          id={id}
          rows={6}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className="font-mono"
          placeholder={"**/*.snap\ndocs/generated/"}
        />
      </Field>
      {server && (
        <Notice tone="error" className="mt-3">
          {server}
        </Notice>
      )}
    </Dialog>
  );
}
