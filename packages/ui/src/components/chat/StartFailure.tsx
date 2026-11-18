import { errorFieldsOf, type Agent } from "@octo/agent-client";
import { Suspense } from "react";
import { recheckAgent } from "../../lib/providers/recheck";
import { startFailureOf } from "../../lib/startFailure";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { providerIdOf, useAgentName, useLoginHint } from "./agentName";
import { TurnBanner } from "./Transcript";

/**
 * The orchestrator failed before anything was stored (an ACP agent that is not logged in): the failed turn shows above
 * the empty project's composer with its message and the agent's login hint — never a silent "Idle".
 */
export function StartFailure({ agent }: { agent: Agent }) {
  const { state } = useProject();
  const failed = startFailureOf(state.lastTurn, agent);
  const login = useLoginHint(failed !== undefined ? agent.model : null);
  const agentName = useAgentName(agent.model);
  const { bridge } = useApp();
  const fromTurn = state.lastTurn?.status === "failed" ? errorFieldsOf(state.lastTurn) : agent.error_hint ? { hint: agent.error_hint } : {};
  const recheck = async () => {
    const id = providerIdOf(agent.model);
    const ready = id ? await recheckAgent(bridge, id).catch(() => false) : false;
    login.recheck();
    return ready;
  };
  if (failed === undefined) return null;
  return (
    <div data-start-failure className="relative mx-auto mt-4 w-full max-w-float">
      <Suspense fallback={null}>
        <TurnBanner
          status="failed"
          error={failed}
          retryText={null}
          fields={{
            ...fromTurn,
            ...(fromTurn.hint || !login.hint ? {} : { hint: login.hint }),
            ...("action" in fromTurn || !login.hint ? {} : { action: "recheck_provider" as const }),
          }}
          agent={agentName}
          flush
          providerId={providerIdOf(agent.model)}
          onCheck={recheck}
        />
      </Suspense>
    </div>
  );
}
