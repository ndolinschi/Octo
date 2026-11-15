/**
 * Code colours for both themes: the Monaco themes (`components/files/monaco.ts`) and the chat / preview
 * highlighter (`lib/highlight.ts`) read this one palette. Every token colour is ≥ 4.5:1 on the panel and on the diff tints
 * (a changed word over a changed line, the strongest: dark #294231 / #472f2d, light #c5ded0 / #efd1d0; polish pass F3, item 5,
 * nudged the tokens that fell to 4.1–4.5 there instead of thinning the tints). Comments are a hair off the meta tone
 * (`--octo-fg-3`) for that, never fainter than meta (polish step 4, E4); line numbers sit one step under meta (≈5:1, at the meta
 * tone they were as loud as the code) and the active line's number is `--octo-fg`.
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
  comment: "#a8a8a8",
  keyword: "#85aadf",
  string: "#a5c48f",
  number: "#d8b07a",
  type: "#7cc3b6",
  lineNumber: "#888888",
  lineNumberActive: "#f0f0f0",
  overlay: "#232323",
  raised: "#222222",
  err: "#f6847e",
  warn: "#d8b07a",
  link: "#70a9ff",
  tint: (a) => `#ffffff${a}`,
};

export const CODE_LIGHT: CodePalette = {
  text: "#262626",
  strong: "#141414",
  muted: "#5e5e5e",
  comment: "#5d5d5d",
  keyword: "#2a5da1",
  string: "#3b672a",
  number: "#845111",
  type: "#146863",
  lineNumber: "#707070",
  lineNumberActive: "#1a1a1a",
  overlay: "#ffffff",
  raised: "#f5f5f5",
  err: "#b42a23",
  warn: "#8a5512",
  link: "#0958c2",
  tint: (a) => `#000000${a}`,
};
