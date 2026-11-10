/**
 * The seam between the lazily loaded LSP client (in the editor chunk) and the always-loaded
 * editor chrome (status, problems popover). The client writes per-file snapshots here; the
 * File tab header reads them with `useSyncExternalStore`. No Monaco or LSP code lives here.
 */

export type LspState = "starting" | "ready" | "failed" | "stopped";
export type LspStatus = { label: string; state: LspState; error: string | null };
export type ProblemSeverity = "error" | "warning" | "info" | "hint";
export type Problem = { severity: ProblemSeverity; message: string; source: string | null; line: number; column: number };

export type FileIntel = { status: LspStatus | null; problems: Problem[]; notice: string | null };

/** What the hub needs from the running client. */
export type IntelClient = { retry(fileKey: string): void; dispose(): void };

const EMPTY: FileIntel = { status: null, problems: [], notice: null };
const NOTICE_MS = 4_000;

export class EditorIntel {
  private files = new Map<string, FileIntel>();
  private listeners = new Set<() => void>();
  private noticeTimers = new Map<string, number>();
  private client: IntelClient | null = null;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };

  get(key: string): FileIntel {
    return this.files.get(key) ?? EMPTY;
  }

  /** Starts the client once (the editor chunk calls this with its factory when Monaco is in). */
  start(create: () => IntelClient): void {
    this.client ??= create();
  }

  retry(key: string): void {
    this.client?.retry(key);
  }

  setStatus(key: string, status: LspStatus | null): void {
    this.patch(key, { status });
  }

  setProblems(key: string, problems: Problem[]): void {
    this.patch(key, { problems });
  }

  /** A short-lived, quiet message in the file's header (e.g. a definition outside the project). */
  notify(key: string, notice: string): void {
    window.clearTimeout(this.noticeTimers.get(key));
    this.patch(key, { notice });
    this.noticeTimers.set(key, window.setTimeout(() => this.patch(key, { notice: null }), NOTICE_MS));
  }

  /** Forgets a closed file. */
  clear(key: string): void {
    window.clearTimeout(this.noticeTimers.get(key));
    if (this.files.delete(key)) this.emit();
  }

  /** Stops the client and forgets every file (a later `start` begins afresh). */
  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this.noticeTimers.forEach((t) => window.clearTimeout(t));
    this.files.clear();
    this.emit();
  }

  private patch(key: string, next: Partial<FileIntel>) {
    const prev = this.get(key);
    if (Object.entries(next).every(([k, v]) => prev[k as keyof FileIntel] === v)) return;
    this.files.set(key, { ...prev, ...next });
    this.emit();
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }
}
