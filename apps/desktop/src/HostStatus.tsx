import type { HostState } from "./hostBridge";

/** The desktop app's own start-up screen: "Starting Octo…", or what went wrong with the log tail and Retry. */
export function HostStatus({ state, retrying, onRetry }: { state: Exclude<HostState, { phase: "ready" }>; retrying: boolean; onRetry: () => void }) {
  if (state.phase === "starting") {
    return (
      <main className="grid h-full place-items-center bg-window px-6 text-fg" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="grid size-12 place-items-center rounded-xl border border-line bg-panel shadow-sm">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="7" className="stroke-line" strokeWidth="2" />
              <circle cx="12" cy="12" r="7" className="octo-ring-turn stroke-fg" strokeWidth="2" strokeLinecap="round" strokeDasharray="16 28" />
            </svg>
          </div>
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm font-medium text-fg">Starting Octo</p>
            <p className="text-xs text-fg-3">Preparing local workspace and services…</p>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="grid h-full place-items-center bg-window px-6 text-fg" aria-labelledby="host-failed-title">
      <div className="w-full max-w-[560px]">
        <h1 id="host-failed-title" className="text-title text-fg">
          Octo could not start
        </h1>
        <p role="alert" className="mt-1 text-sm text-fg-2">
          {state.message}
        </p>
        {state.log ? (
          <>
            <p className="mt-4 text-xs text-fg-3">Last lines of Octo's service log</p>
            <pre
              // A scrollable region must be reachable by keyboard.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              aria-label="Service log"
              className="mt-1 max-h-64 overflow-auto rounded-md bg-code-bg p-3 font-mono text-xs leading-4 whitespace-pre-wrap text-fg-2"
            >
              {state.log}
            </pre>
          </>
        ) : null}
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-5 inline-flex h-8 items-center rounded-sm bg-primary px-3 text-sm font-medium text-primary-fg hover:opacity-90 disabled:bg-active disabled:text-fg-3"
        >
          {retrying ? "Starting…" : "Retry"}
        </button>
      </div>
    </main>
  );
}
