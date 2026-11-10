export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(`octo.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(`octo.${key}`, value);
  } catch {
    /* storage unavailable; preference stays in memory */
  }
}
