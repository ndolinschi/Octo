import { Check, Copy } from "lucide-react";
import { useCopy } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { Button, IconButton } from "../primitives/Button";
import { Notice } from "../primitives/Notice";

const COMMAND = "cd apps/harness && go run ./cmd/harness serve";

export function OfflineState() {
  const { bridgeUrl, retry, health, cause } = useApp();
  const refused = cause === "refused";
  const [copied, copy] = useCopy();
  const host = useHost();
  const retryButton = (
    <Button variant={host.restart || refused ? "secondary" : "primary"} size="sm" onClick={retry} disabled={health === "checking"}>
      {health === "checking" ? "Checking…" : "Retry"}
    </Button>
  );
  // P2-4: it answered with something that is not JSON (a broken proxy, a crash mid-write), or took the connection and never
  // answered. Either way the app checks again by itself (1–30 s, on focus); Retry checks now.
  if (cause === "unreadable" || cause === "unanswered") {
    return (
      <section aria-labelledby="offline-title" className="grid h-full place-items-center px-6">
        <div className="w-full max-w-[440px] min-w-0">
          <h1 id="offline-title" className="text-title text-fg">
            {cause === "unreadable" ? "Octo's local service sent a reply Octo can't read" : "Octo's local service didn't answer in time"}
          </h1>
          <p className="mt-1 text-sm text-fg-2">
            {cause === "unreadable" ? "It's running, but its reply was not valid." : "It took the request but sent nothing back."} Octo keeps trying by itself;
            if it keeps happening, restart Octo.
          </p>
          <div className="mt-5 flex gap-2">
            {retryButton}
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
  // A15: the service answered and refused this window's API token (it restarted with a new one). Not "nothing answered".
  if (refused) {
    return (
      <section aria-labelledby="offline-title" className="grid h-full place-items-center px-6">
        <div className="w-full max-w-[440px] min-w-0">
          <h1 id="offline-title" className="text-title text-fg">
            Octo's local service didn't accept this window
          </h1>
          {host.managesHarness ? (
            <p className="mt-1 text-sm text-fg-2">
              It's running, but it restarted with a new access key that this window doesn't have. Restart Octo to connect again.
            </p>
          ) : (
            <p className="mt-1 text-sm text-fg-2">
              It answers at <code className="font-mono text-xs text-fg">{bridgeUrl}</code> but refuses this page's API token: it restarted with a new one.
              Reload the page, or start the dev server with the service's token (<code className="font-mono text-xs">VITE_HARNESS_API_TOKEN</code>; the service
              keeps it in <code className="font-mono text-xs">api-token</code> in its data directory).
            </p>
          )}
          <div className="mt-5 flex gap-2">
            {host.managesHarness ? (
              host.restart && (
                <Button variant="primary" size="sm" onClick={host.restart}>
                  Restart Octo
                </Button>
              )
            ) : (
              <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
                Reload the page
              </Button>
            )}
            {retryButton}
          </div>
        </div>
      </section>
    );
  }
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
          Octo's local service isn't answering
        </h1>
        <p className="mt-1 text-sm text-fg-2">
          Nothing answered at <code className="font-mono text-xs text-fg">{bridgeUrl}</code>. Start it with this command, then retry.
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

/**
 * P2-3: Octo's local service stopped answering (or refused this window) after the workspace had loaded. The workspace stays
 * on screen and readable under this line; the composer says why sending is off. (Before anything loaded, `OfflineState`
 * takes the whole panel instead: there is nothing to keep.)
 */
export function OfflineBanner() {
  const { cause, retry, health } = useApp();
  const host = useHost();
  const text =
    cause === "refused"
      ? "Octo's local service didn't accept this window: it restarted with a new access key."
      : cause === "unreadable"
        ? "Octo's local service sent a reply Octo can't read. Octo keeps trying."
        : cause === "unanswered"
          ? "Octo's local service didn't answer in time. Octo keeps trying."
          : "Octo's local service isn't answering. Sending is off until it's back.";
  return (
    <Notice tone="warn" className="px-3 py-1.5">
      {/* B3: the actions keep the text's line (the text wraps beside them on a phone) instead of dropping under it. */}
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">{text}</span>
        <span className="flex shrink-0 gap-2">
          {cause === "refused" && !host.managesHarness && (
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          )}
          {host.restart && (
            <Button size="sm" variant="secondary" onClick={host.restart}>
              Restart Octo
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={retry} disabled={health === "checking"}>
            {health === "checking" ? "Checking…" : "Retry"}
          </Button>
        </span>
      </span>
    </Notice>
  );
}
