type Open = (options: { directory: true; multiple: false; title: string }) => Promise<string | string[] | null>;

/** The system folder chooser (Tauri dialog plugin; loaded on demand). A cancel, an error or an empty answer gives `null`. */
export async function pickFolder(open?: Open): Promise<string | null> {
  try {
    const run = open ?? (await import("@tauri-apps/plugin-dialog")).open;
    const picked = await run({ directory: true, multiple: false, title: "Choose a folder" });
    const first = Array.isArray(picked) ? picked[0] : picked;
    return first ?? null;
  } catch (e) {
    console.warn("octo: the folder dialog failed", e);
    return null;
  }
}
