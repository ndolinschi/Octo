import type { ITheme } from "@xterm/xterm";

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = style.getPropertyValue(name).trim();
  return val || fallback;
}

export function readXtermTheme(): ITheme {
  if (typeof document === "undefined") {
    return { background: "#171717", foreground: "#f0f0f0" };
  }
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const light = root.getAttribute("data-theme") === "light";

  const background = cssVar(style, "--octo-panel", light ? "#ffffff" : "#171717");
  const foreground = cssVar(style, "--octo-fg", light ? "#171717" : "#f0f0f0");
  const selectionBackground = cssVar(style, "--octo-selection", light ? "rgba(37, 99, 235, 0.2)" : "rgba(92, 157, 255, 0.32)");

  if (light) {
    return {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground,
      black: "#1f2328",
      red: "#cf222e",
      green: "#116329",
      yellow: "#7d4e00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#9a6700",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#24292f",
    };
  }

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground,
    black: "#262626",
    red: cssVar(style, "--octo-err", "#f6847e"),
    green: cssVar(style, "--octo-ok", "#5fbf7f"),
    yellow: cssVar(style, "--octo-warn", "#d8b07a"),
    blue: cssVar(style, "--octo-accent", "#5c9dff"),
    magenta: "#c792ea",
    cyan: "#5fb3b3",
    white: cssVar(style, "--octo-fg-2", "#c6c6c6"),
    brightBlack: "#767676",
    brightRed: "#ff9b96",
    brightGreen: "#7ad699",
    brightYellow: "#ebca96",
    brightBlue: "#82b4ff",
    brightMagenta: "#ddb3ff",
    brightCyan: "#7fd4d4",
    brightWhite: "#ffffff",
  };
}
