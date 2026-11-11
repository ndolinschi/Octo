/**
 * Code colours for both themes: the Monaco themes (`components/files/monaco.ts`) and the chat / preview
 * highlighter (`lib/highlight.ts`) read this one palette. Every token colour is ≥ 4.5:1 on the panel.
 */
export type CodePalette = {
  text: string;
  strong: string;
  muted: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  lineNumber: string;
  lineNumberActive: string;
  overlay: string;
  raised: string;
  err: string;
  warn: string;
  link: string;
  /** Alpha-suffixed neutral (white in dark, black in light). */
  tint: (alpha: string) => string;
};

export const CODE_DARK: CodePalette = {
  text: "#d8d8d8",
  strong: "#ededed",
  muted: "#a6a6a6",
  comment: "#8a8a8a",
  keyword: "#82a8de",
  string: "#a5c48f",
  number: "#d8b07a",
  type: "#7cc3b6",
  lineNumber: "#808080",
  lineNumberActive: "#d0d0d0",
  overlay: "#232323",
  raised: "#222222",
  err: "#f6847e",
  warn: "#d8b07a",
  link: "#6fa8ff",
  tint: (a) => `#ffffff${a}`,
};

export const CODE_LIGHT: CodePalette = {
  text: "#262626",
  strong: "#141414",
  muted: "#5e5e5e",
  comment: "#6b6b6b",
  keyword: "#2a5ea3",
  string: "#3d6b2c",
  number: "#8a5512",
  type: "#16706a",
  lineNumber: "#737373",
  lineNumberActive: "#262626",
  overlay: "#ffffff",
  raised: "#f5f5f5",
  err: "#b42a23",
  warn: "#8a5512",
  link: "#0a5fd1",
  tint: (a) => `#000000${a}`,
};
