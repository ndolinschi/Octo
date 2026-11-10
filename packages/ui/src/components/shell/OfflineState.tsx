import { Check, Copy, RotateCw, Unplug } from "lucide-react";
import { useCopy } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { Button, IconButton } from "../primitives/Button";

const COMMAND = "cd apps/harness && go run ./cmd/harness serve";

export function OfflineState() {
  const { bridgeUrl, retry, health } = useApp();
  const [copied, copy] = useCopy();
  return (
    <section aria-labelledby="offline-title" className="grid h-full place-items-center px-6">
      <div className="w-full max-w-[460px]">
        <div className="mb-5 grid size-10 place-items-center rounded-lg border border-line-strong bg-raised text-fg-2">
          <Unplug size={18} strokeWidth={1.75} aria-hidden />
        </div>
        <h1 id="offline-title" className="text-xl font-semibold tracking-[-0.015em]">
          Can't reach the harness bridge
        </h1>
        <p className="mt-2 text-[14px] leading-6 text-fg-2">
          Octo talks to a local <code className="font-mono text-[12.5px] text-fg">harness serve</code> process at{" "}
          <code className="font-mono text-[12.5px] text-fg">{bridgeUrl}</code>. Nothing answered there. Start it, then retry —
          Octo also checks again every few seconds.
        </p>
        <div className="mt-5 flex items-center gap-2 rounded-md border border-line bg-code-bg py-1.5 pr-1.5 pl-3">
          <span className="font-mono text-xs text-fg-3 select-none" aria-hidden>
            $
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{COMMAND}</code>
          <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy command"} onClick={() => copy(COMMAND)} />
        </div>
        <p className="mt-2.5 text-xs text-fg-3">
          Different address? Set <code className="font-mono">VITE_HARNESS_BRIDGE_URL</code>. Want to look around first? Open{" "}
          <a href="?demo=1" className="text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">
            demo mode
          </a>
          .
        </p>
        <Button variant="primary" icon={RotateCw} onClick={retry} disabled={health === "checking"} className="mt-6">
          {health === "checking" ? "Checking…" : "Retry"}
        </Button>
      </div>
    </section>
  );
}
