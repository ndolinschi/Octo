/**
 * Starts a download of `url` (the harness answers with an attachment, so the page stays where it is). The one place the UI
 * saves a file the harness serves; a host with its own save dialog would pass a capability instead.
 */
export function startDownload(url: string, name = ""): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
}

/**
 * Saves a project's conversation as Markdown. A real harness wants the token in a header (a plain link carries none), so the
 * file is fetched through the bridge and saved from a Blob URL; the demo and a harness without the fetch fall back to the
 * link. Resolves false when the bridge offers neither.
 */
export async function saveConversation(
  bridge: { exportConversation?(id: string): Promise<{ size: number }>; exportConversationUrl?(id: string): string },
  projectId: string,
): Promise<boolean> {
  if (bridge.exportConversation) {
    // The bridge returns a Blob (typed without the DOM lib in agent-client).
    const blob = (await bridge.exportConversation(projectId)) as Blob;
    const url = URL.createObjectURL(blob);
    try {
      startDownload(url, "conversation.md");
    } finally {
      // The click has handed the URL to the browser's download; free it a moment later.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    return true;
  }
  const url = bridge.exportConversationUrl?.(projectId);
  if (!url) return false;
  startDownload(url);
  return true;
}
