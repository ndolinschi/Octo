import type { ApprovalRule } from "@octo/agent-client";
import { ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { describeRule } from "../../lib/v7/rules";
import { useApp } from "../../state/app";
import { IconButton } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Spinner } from "../primitives/Status";

type Load = { kind: "loading" } | { kind: "ready"; rules: ApprovalRule[] } | { kind: "error"; message: string };

/**
 * Parity B4: the requests this project always allows ("Always allow" on an approval saved them): what each rule covers, and a
 * remove button (the request is asked about again from then on). Hidden when the harness cannot list them.
 */
export function ApprovalRules({ projectId }: { projectId: string }) {
  const { bridge } = useApp();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const list = bridge.listApprovalRules;

  useEffect(() => {
    if (!open || !list) return;
    let alive = true;
    list.call(bridge, projectId).then(
      (rules) => alive && setLoad({ kind: "ready", rules }),
      (e: unknown) =>
        alive &&
        setLoad({
          kind: "error",
          message: `Could not load the saved rules: ${errorMessage(e).replace(/\.$/, "")}. Close and reopen this section to try again.`,
        }),
    );
    return () => {
      alive = false;
    };
  }, [open, list, bridge, projectId]);

  if (!list || !bridge.deleteApprovalRule) return null;
  const remove = async (rule: ApprovalRule) => {
    setRemoving(rule.id);
    setProblem(null);
    try {
      await bridge.deleteApprovalRule?.(projectId, rule.id);
      setLoad((cur) => (cur.kind === "ready" ? { kind: "ready", rules: cur.rules.filter((r) => r.id !== rule.id) } : cur));
    } catch (e) {
      setProblem(`Could not remove the rule: ${errorMessage(e).replace(/\.$/, "")}. Try again.`);
    } finally {
      setRemoving(null);
    }
  };
  return (
    <div data-approval-rules>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-ml-2 inline-flex h-7 items-center gap-1 rounded-sm px-2 text-sm text-fg-2 hover:bg-hover hover:text-fg"
      >
        Always-allowed requests
        <Glyph icon={ChevronRight} size={14} className={cn("text-fg-3", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1 text-sm">
          {load.kind === "loading" && (
            <p className="flex items-center gap-2 text-fg-3">
              <Spinner /> Loading…
            </p>
          )}
          {load.kind === "error" && (
            <p role="alert" className="text-err">
              {load.message}
            </p>
          )}
          {load.kind === "ready" && load.rules.length === 0 && (
            <p className="text-fg-3">Nothing is always allowed. Choose “Always allow” on an approval to add a rule.</p>
          )}
          {load.kind === "ready" && (
            <ul className="flex flex-col">
              {load.rules.map((rule) => {
                const v = describeRule(rule);
                return (
                  <li key={rule.id} className="flex min-h-row items-center gap-2">
                    <span className="w-20 shrink-0 text-fg-3">{v.subject}</span>
                    <span className="min-w-0 flex-1">
                      <code className="font-mono text-xs break-all text-fg">{rule.match}</code>
                      <span className="block text-xs text-fg-3">{v.sentence}</span>
                    </span>
                    <IconButton icon={X} size="sm" label={`Remove the rule for ${rule.match}`} disabled={removing !== null} onClick={() => void remove(rule)} />
                  </li>
                );
              })}
            </ul>
          )}
          {problem && (
            <p role="alert" className="text-err">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
