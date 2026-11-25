/**
 * The commands in an install or login hint (decision 53: "the exact command", each with a copy button). A manifest
 * hint is prose with commands in backticks ("run `grok login`"); a bare `npm install -g <pkg>` counts too; a hint that
 * is itself one short command line ("claude auth login") is that command. Order kept, each once.
 */
export function commandsIn(hint: string | undefined): string[] {
  const text = hint?.trim() ?? "";
  if (!text) return [];
  const out: string[] = [];
  const add = (c: string) => {
    const t = c.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  for (const m of text.matchAll(/`([^`\n]+)`(\s+is\b)?/g)) if (m[1] && !m[2] && looksLikeCommand(m[1])) add(m[1]);
  const prose = text.replace(/`[^`\n]*`/g, " ");
  for (const m of prose.matchAll(/\b((?:npm|pnpm|brew|pipx?|cargo|go) install [^\s(),;]+(?: [^\s(),;]+)*)/g)) if (m[1]) add(m[1].replace(/[.:]$/, ""));
  if (out.length === 0 && isCommandLine(text)) add(text);
  return out;
}

/** A backtick span that is a command, not a flag, file or variable name (`/login` is typed inside the agent). */
function looksLikeCommand(s: string): boolean {
  const t = s.trim();
  return /^[a-z][\w.-]*(\s|$)/.test(t) && !/^[A-Z_]+$/.test(t);
}

function isCommandLine(s: string): boolean {
  return s.length <= 80 && !/[.!?]\s|[.!?]$/.test(s) && /^[a-z][\w.-]*( [^\s]+)*$/.test(s);
}
