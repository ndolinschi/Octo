import { useId, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useApp, type ThemePref } from "../../state/app";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Status";
import { PluginsSection } from "./PluginsSection";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** App-wide settings: theme (unless the host owns it), the bridge connection and the plugins it loaded. */
export function SettingsDialog({ onClose }: { onClose(): void }) {
  const { canChooseTheme, demo } = useApp();
  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-5 pt-1">
        {canChooseTheme && <ThemeChoice />}
        <BridgeStatus demo={demo} />
        <PluginsSection />
      </div>
    </Dialog>
  );
}

function ThemeChoice() {
  const { themePref, setThemePref } = useApp();
  const labelId = useId();
  const index = THEMES.findIndex((t) => t.value === themePref);

  // Radio-group keys: arrows move and select.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = THEMES[(index + delta + THEMES.length) % THEMES.length];
    setThemePref(next.value);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };

  return (
    <section>
      <h3 id={labelId} className="text-sm text-fg-2">
        Theme
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="mt-1.5 grid grid-cols-3 gap-0.5 rounded-md border border-line bg-panel p-0.5"
      >
        {THEMES.map((t) => {
          const checked = t.value === themePref;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={checked}
              data-value={t.value}
              data-autofocus={checked || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => setThemePref(t.value)}
              className={cn(
                "h-7 rounded-sm text-sm transition-[background-color,color] duration-100",
                checked ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-fg-3">System follows your operating system's appearance.</p>
    </section>
  );
}

function BridgeStatus({ demo }: { demo: boolean }) {
  const { bridgeUrl, health, retry, version } = useApp();
  const state = health === "online" ? (demo ? "Demo data, in memory" : `Connected${version ? `, version ${version}` : ""}`) : health === "offline" ? "Offline" : "Connecting…";
  return (
    <section>
      <h3 className="text-sm text-fg-2">Bridge</h3>
      <div className="mt-1.5 flex min-h-9 items-center gap-2 rounded-md border border-line bg-panel py-1 pr-1 pl-3">
        <span aria-hidden className="grid size-3 shrink-0 place-items-center">
          {health === "checking" ? <Spinner size={10} /> : <span className={cn("size-1.5 rounded-full", health === "online" ? "bg-ok" : "bg-err")} />}
        </span>
        <span className="min-w-0 flex-1">
          <code className="block truncate font-mono text-xs text-fg" title={bridgeUrl}>
            {bridgeUrl}
          </code>
          <span role="status" className="block text-xs text-fg-3">
            {state}
          </span>
        </span>
        {health === "offline" && (
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        )}
      </div>
      {!demo && (
        <p className="mt-1.5 text-xs text-fg-3">
          Set <code className="font-mono">VITE_HARNESS_BRIDGE_URL</code> at build time to use another address.
        </p>
      )}
    </section>
  );
}
