import { useCallback, useEffect, useRef, useState } from "react";
import type { AnsweredInput, Approval, ApprovalAnswer, Bridge, InputAnswer, InputRequest } from "@octo/agent-client";
import { useLatest } from "../../lib/hooks";
import { agentDisplayName } from "../../lib/orchestratorMore";
import { approvalDeadline, approvalItems, resolutionCause, type ApprovalItem, type Resolution } from "../../lib/v7/approval";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalGroup } from "./ApprovalGroup";
import { InputFormCard } from "./InputFormCard";
import { useV7Events } from "./useV7Events";

type Segment = { kind: "group"; items: Approval[] } | { kind: "one"; item: ApprovalItem };

/** Two or more pending approvals in a row are one group (decision 91c); resolved ones stay single lines. */
function segments(items: readonly ApprovalItem[]): Segment[] {
  const out: Segment[] = [];
  let run: ApprovalItem[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "group", items: run.map((i) => i.approval) });
    else for (const item of run) out.push({ kind: "one", item });
    run = [];
  };
  for (const item of items) {
    if (item.resolution === null) run.push(item);
    else {
      flush();
      out.push({ kind: "one", item });
    }
  }
  flush();
  return out;
}

/** `synced`: bumped by every re-read after a reconnect; the lists load again (what the stream missed). */
type Ids = { projectId: string; bridge: Bridge; synced: number };

function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? [...list] : [...list, item];
}

/** Approvals seen this session and how each ended; the cards collapse to one line instead of vanishing. */
function useApprovals({ projectId, bridge, synced }: Ids) {
  const [seen, setSeen] = useState<Approval[]>([]);
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  const seenRef = useLatest(seen);
  const local = useRef<Record<string, Resolution>>({});

  useEffect(() => {
    let alive = true;
    void bridge.listApprovals?.(projectId).then(
      (list) => alive && setSeen((s) => list.reduce(upsert, s)),
      // Not loaded: new requests still arrive as events; a reload of the window lists the open ones again.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, synced]);

  useV7Events((e) => {
    if (e.type === "approval.requested") setSeen((s) => upsert(s, e.approval));
    if (e.type === "approval.resolved") {
      const a = seenRef.current.find((x) => x.id === e.id);
      const cause = resolutionCause(e.decision, {
        local: local.current[e.id],
        now: Date.now(),
        deadline: a ? approvalDeadline(a.created_at) : null,
        turnStopped: false,
      });
      setResolved((r) => (r[e.id] ? r : { ...r, [e.id]: cause }));
    }
  });

  const markResolved = useCallback((id: string, r: Resolution) => {
    local.current[id] = r;
    setResolved((all) => ({ ...all, [id]: r }));
  }, []);
  const pending = seen.filter((a) => !resolved[a.id]);
  return { items: approvalItems(pending, seen, resolved), markResolved };
}

/** Forms (`request_input`) seen this session and their answers (names only; secret values never pass through here). */
function useForms({ projectId, bridge, synced }: Ids) {
  const [seen, setSeen] = useState<InputRequest[]>([]);
  const [answered, setAnswered] = useState<Record<string, AnsweredInput>>({});

  useEffect(() => {
    let alive = true;
    void bridge.listInputs?.(projectId).then(
      (list) => alive && setSeen((s) => list.reduce(upsert, s)),
      // Not loaded: new forms still arrive as events.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, synced]);

  useV7Events((e) => {
    if (e.type === "input.requested") setSeen((s) => upsert(s, e.input));
    if (e.type === "input.resolved") setAnswered((a) => ({ ...a, [e.id]: { status: e.status, provided: e.provided, values: e.values } }));
  });

  const markAnswered = useCallback((id: string, a: AnsweredInput) => setAnswered((all) => ({ ...all, [id]: a })), []);
  return { forms: seen, answered, markAnswered };
}

export type ApprovalsSlotProps = {
  /** Opens the requesting agent's tab; the role in the card header becomes a link. */
  onOpenAgent?(agentId: string): void;
};

/**
 * Transcript slot (v7 §3, decision 43): the approval cards and the input forms of the open project, loaded from
 * `listApprovals` / `listInputs` and kept current by events. Renders nothing when the bridge lacks those methods or
 * nothing was asked. Mount at the end of the orchestrator's transcript.
 */
export function ApprovalsSlot(props: ApprovalsSlotProps) {
  const { bridge } = useApp();
  if (!bridge.resolveApproval || !bridge.submitInput) return null;
  return <Live {...props} />;
}

function Live({ onOpenAgent }: ApprovalsSlotProps) {
  const { bridge } = useApp();
  const { projectId, project, synced } = useProject();
  const name = (label: string) => agentDisplayName(label, project?.name);
  const approvals = useApprovals({ projectId, bridge, synced });
  const forms = useForms({ projectId, bridge, synced });
  const resolve = useCallback(
    (id: string, answer: ApprovalAnswer) => bridge.resolveApproval?.(projectId, id, answer) ?? Promise.resolve(),
    [bridge, projectId],
  );
  const submit = useCallback((id: string, answer: InputAnswer) => bridge.submitInput?.(projectId, id, answer) ?? Promise.resolve(), [bridge, projectId]);
  const replace = bridge.putSecret ? (name: string, value: string) => bridge.putSecret?.(projectId, name, value) ?? Promise.resolve() : undefined;
  if (!approvals.items.length && !forms.forms.length) return null;
  const newest = [...approvals.items].reverse().find((i) => i.resolution === null)?.approval.id;
  return (
    <div className="mt-4 flex flex-col gap-4" data-v7-slot="approvals">
      {segments(approvals.items).map((seg) =>
        seg.kind === "group" ? (
          <ApprovalGroup
            key={seg.items[0]?.id}
            approvals={seg.items.map((a) => ({ ...a, agent_label: name(a.agent_label) }))}
            source={project?.name ?? "this project"}
            onResolve={resolve}
            onResolved={approvals.markResolved}
            {...(onOpenAgent ? { onOpenAgent } : {})}
          />
        ) : (
          <ApprovalCard
            key={seg.item.approval.id}
            approval={{ ...seg.item.approval, agent_label: name(seg.item.approval.agent_label) }}
            resolution={seg.item.resolution}
            focusOnArrival={seg.item.approval.id === newest}
            onResolve={resolve}
            onResolved={approvals.markResolved}
            {...(onOpenAgent ? { onOpenAgent } : {})}
          />
        ),
      )}
      {forms.forms.map((request) => (
        <InputFormCard
          key={request.id}
          request={{ ...request, agent_label: name(request.agent_label) }}
          answered={forms.answered[request.id] ?? null}
          onSubmit={submit}
          onAnswered={forms.markAnswered}
          {...(replace ? { onReplaceSecret: replace } : {})}
        />
      ))}
    </div>
  );
}
