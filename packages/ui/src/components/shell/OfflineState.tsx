import { Check, Copy } from "lucide-react";
import { useCopy } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { Button, IconButton } from "../primitives/Button";

const COMMAND = "cd apps/harness && go run ./cmd/harness serve";

export function OfflineState() {
  const { bridgeUrl, retry, health } = useApp();
  const [copied, copy] = useCopy();
  const host = useHost();
  // The packaged app starts the harness itself: no command to run, no address to set; Retry, and a restart when the host has one.
  if (host.managesHarness) {
    return (
      <section aria-labelledby="offline-title" className="grid h-full place-items-center px-6">
        <div className="w-full max-w-[440px] min-w-0">
          <h1 id="offline-title" className="text-title text-fg">
            Octo's local service isn't running.
          </h1>
          <p className="mt-1 text-sm text-fg-2">Octo starts it for you. Try again, or restart Octo if it keeps failing.</p>
          <div className="mt-5 flex gap-2">
            <Button variant="primary" size="sm" onClick={retry} disabled={health === "checking"}>
              {health === "checking" ? "Checking…" : "Retry"}
            </Button>
            {host.restart && (
              <Button variant="secondary" size="sm" onClick={host.restart}>
                Restart Octo
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="offline-title" className="grid h-full place-items-center px-6">
      {/* B56: a grid item may shrink under its content (the command line), so the block fits a 390px window. */}
      <div className="w-full max-w-[440px] min-w-0">
        <h1 id="offline-title" className="text-title text-fg">
          Can't reach the harness bridge
        </h1>
        <p className="mt-1 text-sm text-fg-2">
          Nothing answered at <code className="font-mono text-xs text-fg">{bridgeUrl}</code>. Start the bridge, then retry.
        </p>
        <div className="mt-4 flex h-9 items-center gap-2 rounded-md bg-code-bg pr-1 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{COMMAND}</code>
          <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy command"} size="sm" onClick={() => copy(COMMAND)} />
        </div>
        <p className="mt-3 text-xs text-fg-3">
          Set <code className="font-mono">VITE_HARNESS_BRIDGE_URL</code> for another address, or{" "}
          <a href="?demo=1" className="text-fg-2 underline underline-offset-2 hover:text-fg">
            open the demo
          </a>
          .
        </p>
        <Button variant="primary" size="sm" onClick={retry} disabled={health === "checking"} className="mt-5">
          {health === "checking" ? "Checking…" : "Retry"}
        </Button>
      </div>
    </section>
  );
}
