import type { Provider } from "@octo/agent-client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { agentModelLabel } from "../../lib/models";
import { foldModels, modelsSummary, refreshProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Glyph } from "../primitives/Glyph";
import { Spinner } from "../primitives/Status";
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
    <section className="flex flex-col gap-2">
      <SectionTitle
        aside={
          p.kind === "agent" &&
          bridge.refreshProviderModels && (
            <button
              type="button"
              onClick={() => void refresh()}
              aria-busy={refreshing}
              className="flex h-7 shrink-0 press items-center gap-1.5 rounded-sm px-2 text-xs text-fg-3 hover:bg-hover hover:text-fg"
            >
              {refreshing ? <Spinner /> : <Glyph icon={RefreshCw} size={14} />}
              Refresh
            </button>
          )
        }
      >
        Models
      </SectionTitle>
      <p className="text-xs text-fg-3">{modelsSummary(p, now)}</p>
      {p.models_error && <p className="text-xs text-warn">The last look failed: {p.models_error}. The list below is what was known before.</p>}
      {p.models_note && <p className="text-xs text-fg-3">{p.models_note}</p>}
      {p.models.length === 0 ? (
        <p className="text-sm text-fg-2">{p.kind === "agent" ? "The agent picks its own model." : "No models listed."}</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((m) => (
            <li key={m.id} title={m.id} className="flex h-8 items-center gap-2 text-sm text-fg-2">
              <span className="min-w-0 truncate">{agentModelLabel(m)}</span>
              {m.id === p.default_model && <span className="shrink-0 text-xs text-fg-3">default</span>}
              {m.stale && <span className="shrink-0 text-xs text-fg-3">not advertised last time</span>}
            </li>
          ))}
        </ul>
      )}
      {(hidden > 0 || open) && p.models.length > 6 && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="h-7 w-fit rounded-sm px-1 text-xs text-link hover:underline">
          {open ? "Show fewer" : `Show all ${p.models.length}`}
        </button>
      )}
    </section>
  );
}
