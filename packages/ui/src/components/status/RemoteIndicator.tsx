import { lazy, Suspense } from "react";
import { useApp } from "../../state/app";

const View = lazy(() => import("./RemoteIndicatorView").then((m) => ({ default: m.RemoteIndicatorView })));

/**
 * The status bar's remote-access item (`RemoteIndicatorView`), loaded after the first paint so it costs the entry bundle
 * nothing. Only where the bridge has the control routes, and never on the phone itself (the web shell may not read them).
 */
export function RemoteIndicator() {
  const { shell, bridge } = useApp();
  if (shell === "web" || !bridge.remoteAccess) return null;
  return (
    <Suspense fallback={null}>
      <View />
    </Suspense>
  );
}
