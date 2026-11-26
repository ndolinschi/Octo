import type { Provider } from "@octo/agent-client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { agentModelLabel } from "../../lib/models";
import { foldModels, modelsSummary, refreshProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { SectionTitle } from "./ProviderParts";

/** Decision 89 d: "Models" — the count and when they were looked up, Refresh, the list folded after six. */
export function ProviderModels({ provider: p }: { provider: Provider }) {
  const { bridge } = useApp();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now] = useState(() => Date.now());
  const { shown, hidden } = foldModels(p.models, open);
  const refresh = async () => {
    if (!bridge.refreshProviderModels || refreshing) return;
    setRefreshing(true);
    try {
      await bridge.refreshProviderModels(p.id);
      await refreshProviders(bridge);
    } catch {
      // The list keeps what it had; the harness's reason, if any, arrives as `models_error` on the next read.
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="flex flex-col gap-1">
      <SectionTitle
        aside={
          p.kind === "agent" &&
          bridge.refreshProviderModels && (
            <Button variant="quiet" size="xs" icon={RefreshCw} loading={refreshing} onClick={() => void refresh()} className="-mr-2">
              Refresh
            </Button>
          )
        }
      >
        {/* S5: the count and "updated …" are meta in the caption line. */}
        Models · {modelsSummary(p, now)}
      </SectionTitle>
      {p.models_error && <Notice tone="warn">Could not refresh: {p.models_error.replace(/\.$/, "")}. Showing the earlier list.</Notice>}
      {p.models_note && <p className="text-xs text-fg-3">{p.models_note}</p>}
      {p.models.length === 0 ? (
        <p className="text-sm text-fg-2">{p.kind === "agent" ? "The agent picks its own model." : "No models listed."}</p>
      ) : (
        <div role="list" className="-mx-2 flex flex-col">
          {shown.map((m) => (
            <ListRow
              key={m.id}
              role="listitem"
              size="md"
              tone="quiet"
              tip={m.id}
              title={
                m.id === p.default_model || m.stale ? (
                  // T5: "default" is a quiet badge right after the name; S5: a stale model's note is meta right after the
                  // name too, not at the far edge of the row.
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{agentModelLabel(m)}</span>
                    {m.id === p.default_model && <span className="shrink-0 rounded-xs bg-hover px-1.5 py-0.5 text-xs leading-4 text-fg-3">Default</span>}
                    {m.stale && <span className="shrink-0 text-xs text-fg-3">not listed last time</span>}
                  </span>
                ) : (
                  agentModelLabel(m)
                )
              }
            />
          ))}
        </div>
      )}
      {(hidden > 0 || open) && p.models.length > 6 && (
        <Button variant="link" size="xs" onClick={() => setOpen((o) => !o)} className="self-start">
          {open ? "Show fewer" : `Show all ${p.models.length}`}
        </Button>
      )}
    </section>
  );
}
