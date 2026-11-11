import { createContext, useContext } from "react";

/**
 * The window frame the host draws around the UI (decision 54). `overlay`: the host hides its own title bar and the UI's
 * title bar row sits under the window controls; `insetStart` / `insetEnd`: pixels the row keeps free at its start and end
 * (macOS traffic lights: 78 at the start; Windows or Linux controls drawn by the app: at the end). The default is a browser:
 * no overlay, no insets; the row renders all the same.
 */
export type WindowChrome = { overlay: boolean; insetStart: number; insetEnd: number };

export const NO_CHROME: WindowChrome = { overlay: false, insetStart: 0, insetEnd: 0 };

const ChromeContext = createContext<WindowChrome>(NO_CHROME);

export const ChromeProvider = ChromeContext.Provider;

export function useChrome(): WindowChrome {
  return useContext(ChromeContext);
}
