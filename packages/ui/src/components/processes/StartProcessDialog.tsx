import type { AdhocCommandInput, CommandSuggestion, ProjectCommand } from "@octo/agent-client";
import { Play } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field } from "../primitives/Field";
import { FieldRow } from "../primitives/FieldRow";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { SectionHeader } from "../primitives/SectionHeader";
import { TextField } from "../primitives/TextField";

/**
 * Starts either a configured project command or an ad-hoc shell command in the project's folder, streaming live output
 * into the Processes tab with Stop, Kill and Restart controls.
 */
export function StartProcessDialog(props: {
  commands: readonly ProjectCommand[];
  defaultCwd: string;
  onStart(input: AdhocCommandInput): Promise<void>;
  onClose(): void;
}) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = [useId(), useId(), useId()] as const;

  useEffect(() => {
    if (!bridge.listCommandSuggestions) return;
    let alive = true;
    bridge.listCommandSuggestions(projectId).then(
      (list) => alive && setSuggestions(list.filter((s) => !s.configured).slice(0, 4)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId]);

  const valid = command.trim() !== "";

  const submit = async (input: AdhocCommandInput) => {
    if (busy || input.command.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      await props.onStart({
        command: input.command.trim(),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
      });
      props.onClose();
    } catch (e) {
      setProblem(`The process did not start: ${errorMessage(e).replace(/\.$/, "")}.`);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Start a process"
      description="Runs in your project folder with live output, Stop, Kill and Restart."
      onClose={props.onClose}
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid || busy} onClick={() => void submit({ command, name, cwd })}>
            Start
          </Button>
        </>
      }
    >
      <form
        className="@container flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit({ command, name, cwd });
        }}
      >
        {(props.commands.length > 0 || suggestions.length > 0) && (
          <div className="flex flex-col gap-1">
            <SectionHeader inset>Quick start</SectionHeader>
            {props.commands.map((c) => (
              <ListRow
                key={`cmd:${c.name}`}
                size="sm"
                leading={<Glyph icon={Play} size={14} />}
                title={c.name}
                meta={<span className="font-mono">{c.command}</span>}
                disabled={busy}
                onClick={() => void submit({ name: c.name, command: c.command, ...(c.cwd ? { cwd: c.cwd } : {}) })}
              />
            ))}
            {suggestions.map((s) => (
              <ListRow
                key={`sug:${s.source}:${s.name}`}
                size="sm"
                tone="quiet"
                leading={<Glyph icon={Play} size={14} />}
                title={s.name}
                meta={<span className="font-mono">{s.command}</span>}
                disabled={busy}
                onClick={() => {
                  setName(s.name);
                  setCommand(s.command);
                  if (s.cwd) setCwd(s.cwd);
                }}
              />
            ))}
          </div>
        )}
        <Field label="Command line" htmlFor={ids[0]}>
          <TextField
            id={ids[0]}
            data-autofocus
            value={command}
            spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="pnpm dev --port 5173"
            className="font-mono"
          />
        </Field>
        <FieldRow
          fields={[
            {
              id: ids[1],
              label: "Name (optional)",
              control: <TextField id={ids[1]} value={name} onChange={(e) => setName(e.target.value)} placeholder="Dev server" />,
            },
            {
              id: ids[2],
              label: "Folder (optional)",
              control: (
                <TextField
                  id={ids[2]}
                  value={cwd}
                  spellCheck={false}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder={props.defaultCwd || "."}
                  className="font-mono"
                />
              ),
            },
          ]}
        />
        {problem && <Notice tone="error">{problem}</Notice>}
      </form>
    </Dialog>
  );
}
