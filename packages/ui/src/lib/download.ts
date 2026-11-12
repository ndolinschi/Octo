/**
 * Starts a download of `url` (the harness answers with an attachment, so the page stays where it is). The one place the UI
 * saves a file the harness serves; a host with its own save dialog would pass a capability instead.
 */
export function startDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.click();
}
