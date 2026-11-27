import { lazy, Suspense, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";
import { parseAcp } from "../../lib/models";
import { accountSwitchOffer, chipLabel, modelsPatchForAccountSwitch, refreshProviders, useProviders } from "../../lib/providers";
import { mayChangeProject, ON_YOUR_COMPUTER } from "../../lib/remoteDevice";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import type { MenuItem } from "../primitives/Menu";
import { Menu } from "../primitives/Menu";
import { Notice } from "../primitives/Notice";
import { Presence } from "../primitives/Presence";

const ModelPickerPanel = lazy(() => import("../shared/ModelPickerPanel").then((m) => ({ default: m.ModelPickerPanel })));

/**
 * What a reached plan limit offers (design 2026-11-26 section 7), in the turn banner's button row beside the plain Retry:
 * "Use another account" (the other accounts of the same agent, ready ones first, each with its state and limit; only when the
 * agent can have accounts and another exists) and "Choose another model" (the model picker's own list). A choice updates the
 * project's models the way the composer chip does (`modelsPatchForAccountSwitch`) and then sends the failed request again
 * (`onRetry`); once that happened the old notice shows one line and no buttons. Nothing switches by itself. On a paired device
 * the project cannot be changed, so the row says where to do it and Retry stays.
 */
export function LimitChooser(props: { failedId: string | undefined; onRetry?: (() => Promise<void>) | undefined }) {
  const { bridge } = useApp();
  const { project, update } = useProject();
  const device = useHost().remoteDevice;
  const providers = useProviders(bridge);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retried, setRetried] = useState<string | null>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);

  if (!mayChangeProject(device)) return <span className="text-sm text-fg-3">{ON_YOUR_COMPUTER}.</span>;
  if (!project) return null;
  if (retried !== null) return <span className="text-sm text-fg-3">Retried with {retried}.</span>;
  // The agent that ran out: the one the failed turn names, else the project's own (an orchestrator turn that names no agent).
  const failedId = props.failedId ?? parseAcp(project.models.orchestrator)?.id;
  const list = providers.status === "ready" || providers.status === "error" ? providers.list : null;
  const offer = failedId && list ? accountSwitchOffer(list.providers, failedId, project.models) : ({ kind: "none" } as const);
  const siblings = offer.kind === "choices" ? offer.choices : [];
  const failedLabel = list?.providers.find((p) => p.id === failedId)?.label ?? "this account";

  const choose = async (value: string, label: string, what: "account" | "model") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await update({ models: modelsPatchForAccountSwitch(value, failedId ?? project.models.orchestrator, project.models) });
    } catch (e) {
      setError(
        what === "account"
          ? `Could not switch the account: ${errorMessage(e)}. Try again, or choose another model.`
          : `Could not change the model: ${errorMessage(e)}. Try again, or change it from the composer.`,
      );
      setBusy(false);
      return;
    }
    await refreshProviders(bridge).catch(() => undefined);
    setBusy(false);
    // The project is updated. Sending the request again is the turn's own business: if it fails, its notice says why.
    if (props.onRetry) {
      setRetried(label);
      await props.onRetry().catch(() => undefined);
    }
  };
  const items: MenuItem[] = siblings.map((s) => ({
    id: s.id,
    label: s.label,
    sub: s.status,
    disabled: !s.ready,
    ...(s.ready ? {} : { title: `${s.label} cannot run now: ${s.status}.` }),
    run: () => void choose(s.value, s.label, "account"),
  }));

  return (
    <>
      {offer.kind === "choices" && (
        <Button
          ref={accountButton}
          size="sm"
          variant="secondary"
          loading={busy}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={() => {
            const r = accountButton.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
          }}
        >
          Use another account
        </Button>
      )}
      {offer.kind === "unnamed" && <span className="text-sm text-fg-3">This project does not name {failedLabel}, so there is no account to switch here.</span>}
      {offer.kind === "choices" && !offer.anyReady && (
        <span className="text-sm text-fg-3">No other account can run now. Log one in under Settings → Providers.</span>
      )}
      <Presence show={menu !== null}>
        {menu && <Menu label="Use another account" x={menu.x} y={menu.y} items={items} ignoreRef={accountButton} onClose={() => setMenu(null)} />}
      </Presence>
      <Button
        ref={modelButton}
        size="sm"
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={picking}
        disabled={busy}
        onClick={() => setPicking((o) => !o)}
      >
        Choose another model
      </Button>
      <Presence show={picking}>
        {picking && (
          <Suspense fallback={null}>
            <ModelPickerPanel
              label="Model"
              value={project.models.orchestrator}
              onChoose={(value) => void choose(value, chipLabel(value, list), "model")}
              anchor={modelButton}
              side="top"
              onClose={() => setPicking(false)}
            />
          </Suspense>
        )}
      </Presence>
      {error && <Notice tone="error">{error}</Notice>}
    </>
  );
}
