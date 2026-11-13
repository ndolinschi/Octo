import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLatest } from "./hooks";

/**
 * Preference storage: `localStorage` under the `octo.` prefix, guarded (it can be missing, blocked or full), with every
 * key declared once in `PREFS` and every stored value validated by a codec on read. Formats are the ones written since
 * v6; changing one needs a codec that still reads the old text.
 */

const PREFIX = "octo.";

/** A key from `PREFS`. Only this module can make one, so a key that is not in the registry does not type-check. */
export type PrefKey = string & { readonly __brand: "PrefKey" };
// The brand is applied to strings built right here, from the registry's own names.
const key = (name: string) => name as PrefKey;

/** Every `octo.*` key. A new preference is declared here and nowhere else. */
export const PREFS = {
  /** `"system" | "dark" | "light"` as plain text. */
  theme: key("theme"),
  /** `{ since, projects }`: the last `updated_at` seen per project. */
  seen: key("seen"),
  /** The dock layout of one project (`layout.ts` format). */
  layout: (projectId: string) => key(`layout.${projectId}`),
  /** `{ open, width }`: the file view's tree column. */
  fileTree: (projectId: string) => key(`fileTree.${projectId}`),
  /** Pending code comments of one project (JSON list). */
  comments: (projectId: string) => key(`comments.${projectId}`),
  /** Model names typed in the picker's "Other model…", per agent id: `{ [agentId]: string[] }` (the fallback for a harness that cannot store them). */
  customModels: key("customModels"),
  /** Preferred model and role models per agent id, kept when the bridge cannot store them: `{ [agentId]: { preferred_model?, roles? } }`. */
  agentPrefs: key("agentPrefs"),
  /** Folders chosen in the folder picker (decision 49), newest first: a JSON list of paths. */
  chosenFolders: key("chosenFolders"),
  /** The conversation's width in px beside a side group, as plain text: where the first split opens (decision 60). */
  chatSplit: key("chatSplit"),
  /** Start-screen backdrop (decision 31): `"vivid" | "mono" | "off"` as plain text. */
  backdrop: key("backdrop"),
  /** Models and agent models left out of every picker (decision 59, Settings → Models): a JSON list of setting strings. */
  hiddenModels: key("hiddenModels"),
  /** What opening the app shows (Settings → General): `"last" | "home"` as plain text. */
  startup: key("startup"),
  /** Motion (Settings → Appearance): `"system" | "reduced"` as plain text. */
  motion: key("motion"),
} as const;

/** How a value is stored. `parse` never throws: missing, malformed or foreign text becomes a valid (default) value. */
export type Codec<T> = { parse(raw: string | null): T; stringify(value: T): string };

/** A JSON codec: `validate` turns whatever was parsed (or `undefined` when nothing usable was stored) into a valid `T`. */
export function jsonCodec<T>(validate: (parsed: unknown) => T): Codec<T> {
  return {
    parse(raw) {
      if (raw === null) return validate(undefined);
      try {
        return validate(JSON.parse(raw));
      } catch {
        // Malformed text is the same as nothing stored: the codec's default, never a crash at start-up.
        return validate(undefined);
      }
    },
    stringify: (value) => JSON.stringify(value),
  };
}

/** A plain-text codec for a fixed set of strings; anything else gives `fallback`. */
export function choiceCodec<const T extends string>(choices: readonly T[], fallback: T): Codec<T> {
  return {
    parse: (raw) => choices.find((c) => c === raw) ?? fallback,
    stringify: (value) => value,
  };
}

/** A finite number in [min, max] as plain text; anything else gives `fallback`. */
export function numberCodec(min: number, max: number, fallback: number): Codec<number> {
  return {
    parse: (raw) => {
      const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    },
    stringify: (value) => String(Math.round(value)),
  };
}

export function readPref(k: PrefKey): string | null {
  try {
    return window.localStorage.getItem(`${PREFIX}${k}`);
  } catch {
    return null;
  }
}

/** Writes `value`; `false` when storage is missing, blocked or full (the preference then stays in memory only). */
export function writePref(k: PrefKey, value: string): boolean {
  try {
    window.localStorage.setItem(`${PREFIX}${k}`, value);
    return true;
  } catch {
    return false;
  }
}

/** The stored value for `k`, validated. */
export function loadPref<T>(k: PrefKey, codec: Codec<T>): T {
  return codec.parse(readPref(k));
}

/**
 * State that mirrors a preference: read (and validated) once on mount, written whenever it changes, `debounceMs` after
 * the last change (0: right after the commit). `persistInitial: false` leaves storage alone until the first `set` call.
 */
export function usePersistentState<T>(
  k: PrefKey,
  codec: Codec<T>,
  options: { debounceMs?: number; persistInitial?: boolean } = {},
): [T, Dispatch<SetStateAction<T>>] {
  const { debounceMs = 0, persistInitial = true } = options;
  const [value, setValue] = useState(() => loadPref(k, codec));
  const touched = useRef(persistInitial);
  const codecRef = useLatest(codec);
  const set = useCallback((next: SetStateAction<T>) => {
    touched.current = true;
    setValue(next);
  }, []);
  useEffect(() => {
    if (!touched.current) return undefined;
    const save = () => writePref(k, codecRef.current.stringify(value));
    if (debounceMs <= 0) {
      save();
      return undefined;
    }
    const id = window.setTimeout(save, debounceMs);
    return () => window.clearTimeout(id);
  }, [k, value, debounceMs, codecRef]);
  return [value, set];
}
