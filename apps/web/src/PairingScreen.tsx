import { useId, useState, type SyntheticEvent } from "react";
import { claim, deviceNameFromUA, formatCode, PairingError, type FetchFn, type Phase } from "./pairing";

const pageFetch: FetchFn = (url, init) => window.fetch(url, init);

const FIELD =
  "h-ctl-lg w-full rounded-md border border-field-edge bg-panel px-3 text-input-touch text-fg outline-none placeholder:text-fg-3 transition-[border-color] duration-100 focus-visible:border-fg";

/**
 * The phone's first screen (spec section 8): the code from the computer (filled from a scanned QR link), a name for this
 * device, "Pair"; then "waiting for you to allow this phone on your computer". The app's own primitives are not exported
 * from `@octo/ui`, so this one screen uses the same tokens with plain elements.
 */
export function PairingScreen({ base, phase, onPaired }: { base: string; phase: Phase; onPaired(token: string, name: string): void }) {
  const ids = { code: useId(), name: useId(), note: useId() };
  const initial = phase.kind === "pair" ? phase.code : "";
  const [code, setCode] = useState(initial);
  const [name, setName] = useState(() => deviceNameFromUA(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const notice = phase.kind === "pair" ? phase.notice : null;

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    claim(pageFetch, base, code, name).then(
      (c) => onPaired(c.token, c.name),
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof PairingError ? { message: err.message, hint: err.hint } : { message: String(err), hint: "Try again" });
      },
    );
  };

  return (
    // Add. 8c: `#root` already keeps clear of the notch and the home indicator (styles.css); this screen adds only its own space.
    <main className="flex min-h-full flex-col items-center bg-window px-4 pt-12 pb-6 text-fg">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <img src="/icons/icon-128.png" alt="" width={56} height={56} className="rounded-xl" />
          <h1 className="text-display text-fg">Connect to your computer</h1>
          <p className="text-sm text-fg-2">Octo runs on your computer. This phone reads and answers it while remote access is on there.</p>
        </header>

        {phase.kind === "checking" && (
          <p role="status" className="text-center text-sm text-fg-2">
            Checking this phone…
          </p>
        )}

        {phase.kind === "waiting" && (
          <section
            role="status"
            aria-live="polite"
            className="flex flex-col gap-2 rounded-xl border border-panel-edge bg-panel p-card text-center shadow-panel"
          >
            <p className="text-heading text-fg">Waiting for your computer</p>
            <p className="text-sm text-fg-2">
              Click <span className="font-medium text-fg">Allow</span> next to “{phase.name}” in Octo on your computer (Settings → Remote access).
            </p>
          </section>
        )}

        {phase.kind === "pair" && (
          <form onSubmit={submit} className="flex flex-col gap-4" aria-describedby={ids.note}>
            {notice && (
              <p role="alert" className="rounded-md border border-panel-edge bg-panel p-card text-sm text-fg">
                {notice}
              </p>
            )}
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.code} className="text-sm text-fg-2">
                Pairing code
              </label>
              <input
                id={ids.code}
                className={`${FIELD} font-mono tracking-widest uppercase`}
                value={code}
                onChange={(e) => setCode(formatCode(e.target.value))}
                placeholder="ABCD-EFGH"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                maxLength={9}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.name} className="text-sm text-fg-2">
                Name of this device
              </label>
              <input id={ids.name} className={FIELD} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-err">
                {error.message} <span className="text-fg-2">{error.hint}</span>
              </p>
            )}
            <button
              type="submit"
              disabled={busy || code.replace(/-/g, "").length !== 8}
              className="h-10 rounded-md bg-primary font-medium text-primary-fg disabled:bg-active disabled:text-fg-3"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            <p id={ids.note} className="text-xs text-fg-3">
              On your computer: Settings → Remote access → Add a device. The code works once, for five minutes. If remote access is turned off and on again,
              connect this phone again.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
