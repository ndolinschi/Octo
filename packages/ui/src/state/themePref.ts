import { choiceCodec } from "../lib/storage";

export type Theme = "dark" | "light";
export type ThemePref = "system" | Theme;

/** Stored as plain text (`octo.theme`); an unknown value means "system". */
export const themeCodec = choiceCodec<ThemePref>(["system", "dark", "light"], "system");
