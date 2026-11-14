import { useState, type ReactNode } from "react";
import type { AnsweredInput, Approval, ApprovalAnswer, InputAnswer, InputRequest, TurnChanges } from "@octo/agent-client";
import { earlierRequestLabel } from "../../lib/v7/changes";
import { useApp } from "../../state/app";
import type { Resolution } from "../../lib/v7/approval";
import { ApprovalCard } from "./ApprovalCard";
import { ChangesView } from "./ChangesView";
import type { DiffMonaco } from "./DiffEditor";
import { APPROVALS, changesApi, FORMS, QUEUE, TURN_LABELS, type RevertMode } from "./galleryData";
import { InputFormCard } from "./InputFormCard";
import { QueueBadge, QueueList } from "./QueueList";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Every v7 component in every state, for review (`#/__v7`, demo builds only; nothing here is wired to a bridge).
 * Pending cards answer after a short delay; the "fails" ones show the error line and the retry.
 */
export function Gallery({ loadMonaco }: { loadMonaco(): Promise<DiffMonaco> }) {
  const { theme } = useApp();
  return (
    <main className="bg-bg h-full overflow-y-auto text-fg" data-v7-gallery>
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-title text-fg">v7 components</h1>
          <p className="text-fg-2">Approvals, forms, the queue and the changes view, in every state. Theme: {theme}.</p>
        </header>
        <Approvals />
        <Forms />
        <Queue />
        <Changes theme={theme} loadMonaco={loadMonaco} />
      </div>
    </main>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="flex flex-col gap-4">
      <h2 id={`${id}-h`} className="text-heading text-fg">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Case({ label, children, narrow = false }: { label: string; children: ReactNode; narrow?: boolean }) {
  return (
    <figure className="flex flex-col gap-1.5" data-case={label}>
      <figcaption className="text-xs text-fg-3">{label}</figcaption>
      <div className={narrow ? "max-w-sm" : "max-w-2xl"}>{children}</div>
    </figure>
  );
}

function ApprovalDemo({ approval, fails = false, initial = null }: { approval: Approval; fails?: boolean; initial?: Resolution | null }) {
  const [resolution, setResolution] = useState<Resolution | null>(initial);
  const resolve = async (_id: string, _answer: ApprovalAnswer) => {
    await wait(350);
    if (fails) throw new Error("connection refused");
  };
  return <ApprovalCard approval={approval} resolution={resolution} onResolve={resolve} onResolved={(_id, r) => setResolution(r)} />;
}

function Approvals() {
  return (
    <Section id="approvals" title="Approvals">
      <Case label="Pending: command (press A or D on the card)">
        <ApprovalDemo approval={APPROVALS.command} />
      </Case>
      <Case label="Pending: file edit">
        <ApprovalDemo approval={APPROVALS.write} />
      </Case>
      <Case label="Pending: ACP agent's own options">
        <ApprovalDemo approval={APPROVALS.acp} />
      </Case>
      <Case label="Pending: last minute (countdown warns)">
        <ApprovalDemo approval={APPROVALS.urgent} />
      </Case>
      <Case label="Pending: the answer fails (click Allow once)">
        <ApprovalDemo approval={{ ...APPROVALS.command, id: "apr_err" }} fails />
      </Case>
      <Case label="Resolved: allowed once (command)">
        <ApprovalDemo approval={APPROVALS.command} initial={{ decision: "allow", by: "you" }} />
      </Case>
      <Case label="Resolved: allowed for this turn (file edit)">
        <ApprovalDemo approval={APPROVALS.write} initial={{ decision: "allow_for_turn", by: "you" }} />
      </Case>
      <Case label="Resolved: denied with a note">
        <ApprovalDemo approval={APPROVALS.command} initial={{ decision: "deny", by: "you", note: "Run the tests without committing" }} />
      </Case>
      <Case label="Resolved: ACP option">
        <ApprovalDemo approval={APPROVALS.acp} initial={{ decision: "allow", by: "you", option: "Always allow" }} />
      </Case>
      <Case label="Expired: denied automatically">
        <ApprovalDemo approval={APPROVALS.urgent} initial={{ decision: "deny", by: "timeout" }} />
      </Case>
      <Case label="Resolved elsewhere / turn stopped">
        <div className="flex flex-col gap-2">
          <ApprovalDemo approval={APPROVALS.write} initial={{ decision: "allow", by: "elsewhere" }} />
          <ApprovalDemo approval={APPROVALS.command} initial={{ decision: "deny", by: "cancelled" }} />
        </div>
      </Case>
      <Case label="Narrow column (320px)" narrow>
        <ApprovalDemo approval={APPROVALS.acp} />
      </Case>
    </Section>
  );
}

function FormDemo({ request, fails = false, initial = null }: { request: InputRequest; fails?: boolean; initial?: AnsweredInput | null }) {
  const [answered, setAnswered] = useState<AnsweredInput | null>(initial);
  const submit = async (_id: string, _answer: InputAnswer) => {
    await wait(400);
    if (fails) throw new Error("Octo's local service is not reachable");
  };
  return (
    <InputFormCard
      request={request}
      answered={answered}
      onSubmit={submit}
      onAnswered={(_id, a) => setAnswered(a)}
      onReplaceSecret={async () => {
        await wait(300);
      }}
    />
  );
}

function Forms() {
  return (
    <Section id="forms" title="Input forms">
      <Case label="Open: text, secret, choices, long select, path, confirm (submit empty for the validation errors)">
        <FormDemo request={FORMS.full} />
      </Case>
      <Case label="Open: one secret">
        <FormDemo request={FORMS.secret} />
      </Case>
      <Case label="Open: sending fails (fill the fields, then Send)">
        <FormDemo request={{ ...FORMS.secret, id: "inp_fail" }} fails />
      </Case>
      <Case label="Answered: submitted (secret provided, Change offered)">
        <FormDemo request={FORMS.full} initial={{ status: "submitted", provided: ["token"], values: { name: "octo-api", region: "eu-west", yes: true } }} />
      </Case>
      <Case label="Answered: skipped">
        <FormDemo request={FORMS.full} initial={{ status: "skipped", provided: [], values: {} }} />
      </Case>
      <Case label="Answered: closed with the turn">
        <FormDemo request={FORMS.secret} initial={{ status: "cancelled", provided: [], values: {} }} />
      </Case>
      <Case label="Narrow column (320px)" narrow>
        <FormDemo request={{ ...FORMS.full, id: "inp_narrow" }} />
      </Case>
    </Section>
  );
}

function Queue() {
  const noop = async () => {
    await wait(200);
  };
  const [count, setCount] = useState(2);
  const props = { onRemove: noop, onSendNow: noop, onStopAndSend: noop, onResume: noop, onClear: noop };
  const failing = async () => {
    await wait(200);
    throw new Error("Octo's local service did not answer");
  };
  return (
    <Section id="queue" title="Message queue">
      <Case label="One message">
        <QueueList paused={false} messages={QUEUE.slice(0, 1)} {...props} />
      </Case>
      <Case label="Five messages (folded after three)">
        <QueueList paused={false} messages={QUEUE} {...props} />
      </Case>
      <Case label="Paused, three messages">
        <QueueList paused messages={QUEUE.slice(0, 3)} {...props} />
      </Case>
      <Case label="Paused, empty">
        <QueueList paused messages={[]} {...props} />
      </Case>
      <Case label="Removing fails (click the x)">
        <QueueList paused={false} messages={QUEUE.slice(0, 2)} {...props} onRemove={failing} />
      </Case>
      <Case label="Narrow column (320px)" narrow>
        <QueueList paused messages={QUEUE.slice(0, 3)} {...props} />
      </Case>
      <Case label="Count on the send button">
        <div className="flex items-center gap-4">
          <span className="relative inline-grid size-8 place-items-center rounded-md border border-line-strong">
            <span aria-hidden="true">↑</span>
            <QueueBadge count={count} />
          </span>
          <button type="button" className="text-fg-2 underline" onClick={() => setCount((c) => (c + 3) % 12)}>
            Change count ({count})
          </button>
        </div>
      </Case>
    </Section>
  );
}

function Pane({ height = 520, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-line" style={{ height }}>
      {children}
    </div>
  );
}

function Changes({ theme, loadMonaco }: { theme: "dark" | "light"; loadMonaco(): Promise<DiffMonaco> }) {
  const [last, setLast] = useState<string>("none yet");
  const label = (turn: TurnChanges) => TURN_LABELS[turn.turn_id] ?? earlierRequestLabel(turn, Date.now());
  const view = (mode: "ready" | "empty" | "loading" | "error", revert: RevertMode = "ok", extra: { height?: number } = {}) => (
    <Pane height={extra.height ?? 520}>
      <ChangesView
        api={changesApi(mode, revert)}
        theme={theme}
        loadMonaco={loadMonaco}
        turnLabel={label}
        onAddComment={(c) => setLast(`${c.path}:${c.start}-${c.end} ${c.text}`)}
      />
    </Pane>
  );
  const named = (title: string, node: ReactNode) => (
    <figure className="flex flex-col gap-1.5" data-case={title}>
      <figcaption className="text-xs text-fg-3">{title}</figcaption>
      {node}
    </figure>
  );
  return (
    <Section id="changes" title="Changes">
      {named("List and diff (add a comment from the gutter; revert one file)", view("ready"))}
      <p className="text-xs text-fg-3">Last comment: {last}</p>
      {named("Revert succeeds (pick a file, Revert, confirm)", view("ready", "slow"))}
      {named("Revert refused: file changed since (409)", view("ready", "file_changed"))}
      {named("Revert refused: no stored original (409)", view("ready", "revert_unavailable"))}
      {named("Empty", view("empty", "ok", { height: 220 }))}
      {named("Loading", view("loading", "ok", { height: 220 }))}
      {named("Error", view("error", "ok", { height: 220 }))}
      {named("Narrow pane (360px: list, then diff)", <div style={{ maxWidth: 360 }}>{view("ready", "ok", { height: 560 })}</div>)}
    </Section>
  );
}
