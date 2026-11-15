import type { Diagnostics } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useCopy } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { SkeletonList } from "../primitives/Skeleton";
import { Switch } from "../primitives/Switch";
import { TextField } from "../primitives/TextField";
import { diagnosticReport } from "./diagnosticReport";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { CONTROL_W, LoadErrorRow, SaveStatus, SettingsGroup, SettingsRow } from "./parts";
import { useSave } from "./useSave";

type DiagLoad = { status: "loading" } | { status: "unavailable" } | { status: "error"; message: string } | { status: "ready"; d: Diagnostics };

function useDiagnostics(): [DiagLoad, () => void] {
  const { bridge } = useApp();
  const [load, setLoad] = useState<DiagLoad>(() => (bridge.getDiagnostics ? { status: "loading" } : { status: "unavailable" }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!bridge.getDiagnostics) return;
    let live = true;
    bridge.getDiagnostics().then(
      (d) => live && setLoad({ status: "ready", d }),
      (e: unknown) => live && setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
    return () => {
      live = false;
    };
  }, [bridge, attempt]);
  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return [load, retry];
}

/** Decision 59 / R1.5: the data folder, the wire trace switch, the variables agents see, and the report to send. */
export function PrivacySection() {
  const [diag, retry] = useDiagnostics();
  return (
    <>
      <SettingsGroup label="Report a problem">
        <ReportRow diag={diag} retry={retry} />
        <TraceRow />
      </SettingsGroup>
      <SettingsGroup label="Data">
        {diag.status === "loading" ? <SkeletonList count={1} size="lg" twoLine /> : <DataDirRow dir={diag.status === "ready" ? diag.d.data_dir : null} />}
        <ChildEnvRow />
      </SettingsGroup>
    </>
  );
}

function ReportRow({ diag, retry }: { diag: DiagLoad; retry(): void }) {
  const { bridgeUrl, shell } = useApp();
  const [copied, copy] = useCopy();
  if (diag.status === "unavailable")
    return <SettingsRow rowId="diagnostics" title="Copy diagnostic report" description="This window can't make a diagnostic report." />;
  if (diag.status === "error")
    return <LoadErrorRow what="the diagnostic report" message={diag.message} hint="Retry once Octo's local service is running." onRetry={retry} />;
  const problems = diag.status === "ready" ? diag.d.problems.length : 0;
  return (
    <SettingsRow
      rowId="diagnostics"
      title="Copy diagnostic report"
      description={`Versions, agents and the last log lines, without secrets.${problems ? ` ${problems === 1 ? "1 problem" : `${problems} problems`} found.` : ""}`}
      control={
        <Button
          size="sm"
          icon={copied ? Check : Copy}
          disabled={diag.status !== "ready"}
          onClick={() => diag.status === "ready" && copy(diagnosticReport(diag.d, { bridgeUrl, shell }))}
        >
          {copied ? "Copied" : "Copy report"}
        </Button>
      }
    />
  );
}

function TraceRow() {
  const harness = useHarnessSettings();
  const { restart } = useSettingsActions();
  const [saved, run] = useSave();
  const id = useId();
  const s = harness.get(SETTING_IDS.acpTrace);
  if (harness.load.status === "loading") return <SkeletonList count={1} size="lg" twoLine />;
  return (
    <SettingsRow
      rowId="trace"
      title="Record what agents send and receive"
      htmlFor={s ? id : undefined}
      help="Saves what each agent sends and receives to a file in the data folder, with secrets removed. Turn it on to diagnose a failing agent, then attach the file to your report."
      description={s ? "Saves each agent conversation to a file in the data folder, secrets removed." : "Not available on this connection."}
      status={<SaveStatus state={saved} restart={s ? harness.needsRestart(s.id) : false} onRestart={restart} />}
      control={
        s ? (
          <Switch
            id={id}
            label="Record what agents send and receive"
            disabled={!s.editable}
            checked={s.value === true}
            onChange={(on) => void run(() => harness.save({ set: { [s.id]: on } }))}
          />
        ) : undefined
      }
    />
  );
}

function DataDirRow({ dir }: { dir: string | null }) {
  const [copied, copy] = useCopy();
  return (
    <SettingsRow
      rowId="data-dir"
      title="Data folder"
      description={dir ? <code className="font-mono text-xs break-all">{dir}</code> : "Known once Octo's local service reports it."}
      control={
        dir ? (
          <Button size="sm" icon={copied ? Check : Copy} onClick={() => copy(dir)}>
            {copied ? "Copied" : "Copy path"}
          </Button>
        ) : undefined
      }
    />
  );
}

function ChildEnvRow() {
  const harness = useHarnessSettings();
  const [saved, run] = useSave();
  const id = useId();
  const s = harness.get(SETTING_IDS.childEnvAllow);
  const stored = Array.isArray(s?.value) ? s.value.join(", ") : "";
  const [draft, setDraft] = useState<string | null>(null);
  if (!s) return null;
  const commit = () => {
    if (draft === null || draft.trim() === stored) return setDraft(null);
    const list = draft
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    void run(() => harness.save({ set: { [s.id]: list } })).then((ok) => ok && setDraft(null));
  };
  return (
    <SettingsRow
      rowId="child-env"
      title="Environment passed to agents"
      htmlFor={id}
      help={`${s.hint ?? ""} A name ending in * (such as MY_APP_*) covers every variable that starts with it.`.trim()}
      description="Names of extra environment variables agents and tools may see, separated by commas."
      status={<SaveStatus state={saved} />}
      control={
        <TextField
          size="sm"
          id={id}
          value={draft ?? stored}
          disabled={!s.editable}
          placeholder="None"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className={`${CONTROL_W.lg} font-mono`}
        />
      }
    />
  );
}
