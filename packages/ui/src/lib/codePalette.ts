import type { Theme } from "./theme";

/**
 * Code colours for all themes: the Monaco themes (`components/files/monaco.ts`) and the chat / preview
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

export const CODE_CURSOR: CodePalette = {
  ...CODE_DARK,
  text: "#d8d8e0",
  strong: "#ededf0",
  muted: "#9c9ca8",
  comment: "#9c9ca8",
  keyword: "#7fb4ff",
  type: "#6fd1bf",
  lineNumber: "#7d7d8a",
  lineNumberActive: "#ededf0",
  overlay: "#26262c",
  raised: "#212126",
  err: "#f17878",
  warn: "#e5b567",
  link: "#6bb5ff",
};

export const CODE_CLAUDE: CodePalette = {
  ...CODE_DARK,
  text: "#ded9d0",
  strong: "#f2efe9",
  muted: "#ada497",
  comment: "#ada497",
  keyword: "#e2987b",
  string: "#a7c68b",
  number: "#e0a960",
  type: "#7fc6b2",
  lineNumber: "#8a8276",
  lineNumberActive: "#f2efe9",
  overlay: "#2b2823",
  raised: "#26231f",
  err: "#eb7a72",
  warn: "#e0a960",
  link: "#e58d70",
};

export const CODE_CODEX: CodePalette = {
  ...CODE_DARK,
  text: "#d6dce6",
  strong: "#eef1f6",
  muted: "#98a3b3",
  comment: "#98a3b3",
  keyword: "#79c8a8",
  string: "#9ac78f",
  number: "#dfb064",
  type: "#76bfd9",
  lineNumber: "#7a8596",
  lineNumberActive: "#eef1f6",
  overlay: "#22272f",
  raised: "#1d2128",
  err: "#f07b78",
  warn: "#dfb064",
  link: "#52c99d",
};

export const CODE_OPENCODE: CodePalette = {
  ...CODE_DARK,
  text: "#dad9e6",
  strong: "#ececf2",
  muted: "#9c9dad",
  comment: "#9c9dad",
  keyword: "#a89bff",
  string: "#99c897",
  number: "#e3b368",
  type: "#76c9c2",
  lineNumber: "#7f7f91",
  lineNumberActive: "#ececf2",
  overlay: "#22222b",
  raised: "#1c1c24",
  err: "#f27c85",
  warn: "#e3b368",
  link: "#b0a3ff",
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

export const CODE_PALETTES: Record<Theme, CodePalette> = {
  dark: CODE_DARK,
  cursor: CODE_CURSOR,
  claude: CODE_CLAUDE,
  codex: CODE_CODEX,
  opencode: CODE_OPENCODE,
  light: CODE_LIGHT,
};
