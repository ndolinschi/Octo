/**
 * Lightweight channel for running a fenced shell code block from Markdown in the workspace Terminal tab
 * without `components/shared` importing `components/terminal` (`octo/layer-imports`).
 */
const SHELL_LANGS = new Set(["bash", "sh", "zsh", "shell", "fish", "console"]);

export function isShellLang(lang: string | undefined): boolean {
  return lang !== undefined && SHELL_LANGS.has(lang.toLowerCase());
}

type Listener = () => void;

let pendingCommand: string | null = null;
const listeners = new Set<Listener>();

export function queueTerminalCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  pendingCommand = trimmed;
  listeners.forEach((fn) => fn());
}

export function takeTerminalCommand(): string | null {
  const cmd = pendingCommand;
  pendingCommand = null;
  return cmd;
}

export function onTerminalCommand(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
