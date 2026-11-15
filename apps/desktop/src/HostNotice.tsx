import { useState } from "react";
import type { HostNotice as Notice } from "./hostNotices";
import { noticeSummary } from "./hostNotices";

/**
 * One quiet line in the corner for something that does not stop the app (the router did not start): what happened,
 * "Details" for the log tail, "Retry" to restart the sidecars, and a dismiss. Fixed-position, so the UI's layout is
 * untouched.
 */
export function HostNotice({ notice, retrying, onRetry, onDismiss }: { notice: Notice; retrying: boolean; onRetry: () => void; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const button = "shrink-0 rounded-sm px-1.5 text-xs text-link hover:underline focus-visible:underline disabled:text-fg-3 disabled:no-underline";
  return (
    <section
      aria-label="Notice"
      className="fixed bottom-3 left-3 z-50 w-[min(520px,calc(100vw-1.5rem))] rounded-md border border-line-strong bg-overlay text-sm text-fg shadow-pop"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <p role="status" className="min-w-0 flex-1 truncate text-fg-2" title={noticeSummary(notice)}>
          {noticeSummary(notice)}
        </p>
        {notice.logTail ? (
          <button type="button" className={button} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide details" : "Details"}
          </button>
        ) : null}
        <button type="button" className={button} disabled={retrying} onClick={onRetry}>
          {retrying ? "Retrying…" : "Retry"}
        </button>
        <button type="button" className={button} aria-label="Dismiss notice" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {open && notice.logTail ? (
        <pre
          // A scrollable region must be reachable by keyboard.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          aria-label="Octo router log"
          className="mx-3 mb-3 max-h-56 overflow-auto rounded-md bg-code-bg p-3 font-mono text-xs leading-4 whitespace-pre-wrap text-fg-2"
        >
          {notice.logTail}
        </pre>
      ) : null}
    </section>
  );
}
