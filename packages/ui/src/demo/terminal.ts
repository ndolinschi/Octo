import { BridgeError, type Bridge, type TerminalExit, type TerminalOpenOptions, type TerminalSession, type WorkerProcess } from "@octo/agent-client";
import { ensureSeeded, listDemoFiles, readDemoFile } from "./files";
import { newId, type ProjectRecord } from "./store";

const LATENCY_MS = 40;
const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));

type DemoTermRecord = {
  id: string;
  projectId: string;
  folder: string;
  rootPath: string;
  subpath: string;
  shell: string;
  pid: number;
  startedAt: string;
  closed: boolean;
  outputTail: string;
  line: string;
  history: string[];
  histIdx: number;
  outListeners: Set<(chunk: Uint8Array) => void>;
  exitListeners: Set<(exit: TerminalExit) => void>;
  emitText(text: string): void;
  terminate(code: number, reason?: string): void;
};

const encoder = new TextEncoder();

function resolveSubpath(cur: string, target: string): string | null {
  if (!target || target === "~") return "";
  const parts = (target.startsWith("/") ? target : cur ? `${cur}/${target}` : target).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(p);
    }
  }
  return stack.join("/");
}

export function withDemoTerminals(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const active = new Map<string, DemoTermRecord>();
  let nextPid = 51400;

  const getProject = (pid: string): ProjectRecord => {
    const r = records.get(pid);
    if (!r) throw new BridgeError(404, "not_found", "project not found");
    return r;
  };

  const formatPrompt = (t: DemoTermRecord): string => {
    const rel = t.subpath ? `/${t.subpath}` : "";
    return `\x1b[32mmaya@octo\x1b[0m:\x1b[34m~/code/${t.folder}${rel}\x1b[0m$ `;
  };

  const runShellLine = (rec: ProjectRecord, t: DemoTermRecord, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      t.emitText(formatPrompt(t));
      return;
    }
    t.history.push(trimmed);
    t.histIdx = t.history.length;

    const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((tok) => tok.replace(/^['"]|['"]$/g, "")) ?? [];
    const cmd = tokens[0] ?? "";
    const args = tokens.slice(1);

    switch (cmd) {
      case "help":
        t.emitText(
          [
            "Demo interactive shell commands:",
            "  pwd, ls [dir], cd [dir], cat <file>, echo <text>",
            "  git status, pnpm test, whoami, uname -a, clear, exit",
            "",
          ].join("\r\n") + formatPrompt(t),
        );
        return;
      case "clear":
        t.emitText("\x1b[2J\x1b[H" + formatPrompt(t));
        return;
      case "pwd": {
        const suffix = t.subpath ? `/${t.subpath}` : "";
        t.emitText(`${t.rootPath}${suffix}\r\n` + formatPrompt(t));
        return;
      }
      case "whoami":
        t.emitText("maya\r\n" + formatPrompt(t));
        return;
      case "uname":
        t.emitText("Darwin octo.local 24.1.0 arm64\r\n" + formatPrompt(t));
        return;
      case "echo":
        t.emitText(`${args.join(" ")}\r\n` + formatPrompt(t));
        return;
      case "ls": {
        const target = args.find((a) => !a.startsWith("-")) ?? "";
        const nextPath = target ? resolveSubpath(t.subpath, target) : t.subpath;
        if (nextPath === null) {
          t.emitText(`ls: ${target}: Permission denied\r\n` + formatPrompt(t));
          return;
        }
        try {
          const items = listDemoFiles(rec, t.folder, nextPath);
          const rendered = items.map((entry) => (entry.type === "dir" ? `\x1b[34m${entry.name}/\x1b[0m` : entry.name)).join("  ");
          t.emitText((rendered ? `${rendered}\r\n` : "") + formatPrompt(t));
        } catch {
          t.emitText(`ls: ${target || "."}: No such file or directory\r\n` + formatPrompt(t));
        }
        return;
      }
      case "cd": {
        const target = args[0] ?? "";
        const nextPath = resolveSubpath(t.subpath, target);
        if (nextPath === null) {
          t.emitText(`cd: ${target}: Outside project folder\r\n` + formatPrompt(t));
          return;
        }
        try {
          listDemoFiles(rec, t.folder, nextPath);
          t.subpath = nextPath;
          t.emitText(formatPrompt(t));
        } catch {
          t.emitText(`cd: no such file or directory: ${target}\r\n` + formatPrompt(t));
        }
        return;
      }
      case "cat": {
        const target = args[0];
        if (!target) {
          t.emitText("cat: missing file operand\r\n" + formatPrompt(t));
          return;
        }
        const filePath = resolveSubpath(t.subpath, target);
        if (!filePath) {
          t.emitText(`cat: ${target}: Invalid path\r\n` + formatPrompt(t));
          return;
        }
        try {
          const file = readDemoFile(rec, t.folder, filePath);
          const normalized = file.content.replace(/\r?\n/g, "\r\n");
          t.emitText(normalized + (normalized.endsWith("\r\n") ? "" : "\r\n") + formatPrompt(t));
        } catch {
          t.emitText(`cat: ${target}: No such file or directory\r\n` + formatPrompt(t));
        }
        return;
      }
      case "git":
        if (args[0] === "status") {
          t.emitText(
            ["On branch main", "Your branch is up to date with 'origin/main'.", "nothing to commit, working tree clean", ""].join("\r\n") + formatPrompt(t),
          );
          return;
        }
        if (args[0] === "branch") {
          t.emitText("* \x1b[32mmain\x1b[0m\r\n" + formatPrompt(t));
          return;
        }
        t.emitText(`git: '${args[0] ?? ""}' simulated in demo mode\r\n` + formatPrompt(t));
        return;
      case "pnpm":
      case "npm":
        if (args[0] === "test") {
          t.emitText(
            [
              `> ${t.folder}@1.0.0 test`,
              " \x1b[32m✓\x1b[0m src/billing/errors.test.ts (4)",
              " \x1b[32m✓\x1b[0m src/billing/retry.test.ts (9)",
              " \x1b[32m✓\x1b[0m src/billing/client.test.ts (12)",
              "",
              " Test Files  \x1b[32m3 passed\x1b[0m (3)",
              "      Tests  \x1b[32m25 passed\x1b[0m (25)",
              "",
            ].join("\r\n") + formatPrompt(t),
          );
          return;
        }
        t.emitText(`${cmd} ${args.join(" ")}: completed (demo)\r\n` + formatPrompt(t));
        return;
      case "exit": {
        const code = args[0] ? Number.parseInt(args[0], 10) || 0 : 0;
        t.emitText("logout\r\n");
        t.terminate(code);
        return;
      }
      default:
        t.emitText(`zsh: command not found: ${cmd} (type 'help' for demo commands)\r\n` + formatPrompt(t));
    }
  };

  const handleInput = (rec: ProjectRecord, t: DemoTermRecord, data: string) => {
    let i = 0;
    while (i < data.length) {
      if (data.startsWith("\x1b[A", i)) {
        // Up arrow
        if (t.history.length > 0 && t.histIdx > 0) {
          const erase = "\b \b".repeat(t.line.length);
          t.histIdx -= 1;
          t.line = t.history[t.histIdx] ?? "";
          t.emitText(erase + t.line);
        }
        i += 3;
        continue;
      }
      if (data.startsWith("\x1b[B", i)) {
        // Down arrow
        if (t.histIdx < t.history.length) {
          const erase = "\b \b".repeat(t.line.length);
          t.histIdx += 1;
          t.line = t.history[t.histIdx] ?? "";
          t.emitText(erase + t.line);
        }
        i += 3;
        continue;
      }
      if (data.startsWith("\x1b", i)) {
        // Skip other escape sequences
        i += Math.min(data.length - i, 3);
        continue;
      }
      const ch = data[i] ?? "";
      i += 1;
      if (ch === "\x03") {
        // Ctrl+C
        t.line = "";
        t.histIdx = t.history.length;
        t.emitText("^C\r\n" + formatPrompt(t));
      } else if (ch === "\x0c") {
        // Ctrl+L
        t.emitText("\x1b[2J\x1b[H" + formatPrompt(t) + t.line);
      } else if (ch === "\x04") {
        // Ctrl+D on empty line exits
        if (t.line.length === 0) {
          t.emitText("logout\r\n");
          t.terminate(0);
          return;
        }
      } else if (ch === "\r" || ch === "\n") {
        const submitted = t.line;
        t.line = "";
        t.emitText("\r\n");
        runShellLine(rec, t, submitted);
        if (t.closed) return;
      } else if (ch === "\x7f" || ch === "\b") {
        if (t.line.length > 0) {
          t.line = t.line.slice(0, -1);
          t.emitText("\b \b");
        }
      } else if (ch >= " ") {
        t.line += ch;
        t.emitText(ch);
      }
    }
  };

  const toWorker = (t: DemoTermRecord): WorkerProcess => ({
    id: `term:${t.id}`,
    kind: "terminal",
    name: t.shell,
    command: `/bin/${t.shell} -i`,
    cwd: t.rootPath,
    pid: t.pid,
    status: "running",
    started_at: t.startedAt,
    detail: `Terminal · ${t.folder}`,
    output: t.outputTail,
  });

  return {
    ...base,
    openTerminal: async (projectId: string, options?: TerminalOpenOptions): Promise<TerminalSession> => {
      await delay();
      const rec = getProject(projectId);
      if (rec.project.folders.length === 0) {
        throw new BridgeError(400, "no_folder", "This project has no folder yet.");
      }
      await ensureSeeded(rec);
      const chosen =
        (options?.folder
          ? rec.project.folders.find((f) => f.label.toLowerCase() === options.folder?.toLowerCase() || f.path === options.folder)
          : rec.project.folders[0]) ?? rec.project.folders[0];
      if (!chosen) {
        throw new BridgeError(400, "no_folder", "This project has no folder yet.");
      }

      const id = newId("tm");
      nextPid += 23;
      const pendingChunks: Uint8Array[] = [];

      const termRec: DemoTermRecord = {
        id,
        projectId,
        folder: chosen.label,
        rootPath: chosen.path,
        subpath: "",
        shell: "zsh",
        pid: nextPid,
        startedAt: new Date().toISOString(),
        closed: false,
        outputTail: "",
        line: "",
        history: [],
        histIdx: 0,
        outListeners: new Set(),
        exitListeners: new Set(),
        emitText(text: string) {
          if (termRec.closed) return;
          termRec.outputTail = (termRec.outputTail + text).slice(-8192);
          const bytes = encoder.encode(text);
          if (termRec.outListeners.size === 0) {
            pendingChunks.push(bytes);
          } else {
            termRec.outListeners.forEach((fn) => fn(bytes));
          }
        },
        terminate(code: number, reason?: string) {
          if (termRec.closed) return;
          termRec.closed = true;
          active.delete(id);
          const exit: TerminalExit = { code, ...(reason ? { reason } : {}) };
          termRec.exitListeners.forEach((fn) => fn(exit));
        },
      };

      active.set(id, termRec);
      termRec.emitText(formatPrompt(termRec));

      return {
        sessionId: id,
        folder: termRec.folder,
        cwd: termRec.rootPath,
        shell: termRec.shell,
        pid: termRec.pid,
        write: async (data: string) => {
          if (termRec.closed) throw new BridgeError(404, "terminal_closed", "That terminal session has ended.");
          handleInput(rec, termRec, data);
        },
        resize: async () => undefined,
        onOutput: (fn) => {
          termRec.outListeners.add(fn);
          if (pendingChunks.length > 0) {
            const drained = pendingChunks.splice(0, pendingChunks.length);
            queueMicrotask(() => {
              for (const c of drained) fn(c);
            });
          }
          return () => {
            termRec.outListeners.delete(fn);
          };
        },
        onExit: (fn) => {
          termRec.exitListeners.add(fn);
          return () => {
            termRec.exitListeners.delete(fn);
          };
        },
        close: async () => {
          termRec.terminate(0, "closed");
        },
      };
    },
    listWorkerProcesses: async (projectId: string) => {
      const others = base.listWorkerProcesses ? await base.listWorkerProcesses(projectId) : [];
      const terms = [...active.values()].filter((t) => t.projectId === projectId && !t.closed).map(toWorker);
      return [...terms, ...others];
    },
    stopWorkerProcess: async (projectId: string, procId: string) => {
      if (procId.startsWith("term:")) {
        await delay();
        const tid = procId.slice("term:".length);
        const t = active.get(tid);
        if (!t || t.projectId !== projectId) throw new BridgeError(404, "not_found", "process not found");
        t.emitText("\r\n[terminated]\r\n");
        t.terminate(-1, "stopped");
        return;
      }
      if (!base.stopWorkerProcess) throw new BridgeError(404, "not_found", "process not found");
      return base.stopWorkerProcess(projectId, procId);
    },
    restartWorkerProcess: async (projectId: string, procId: string) => {
      if (procId.startsWith("term:")) {
        await delay();
        const tid = procId.slice("term:".length);
        const t = active.get(tid);
        if (!t || t.projectId !== projectId) throw new BridgeError(404, "not_found", "process not found");
        nextPid += 29;
        t.pid = nextPid;
        t.startedAt = new Date().toISOString();
        t.line = "";
        t.emitText(`\r\n[restarted PID ${t.pid}]\r\n` + formatPrompt(t));
        return toWorker(t);
      }
      if (!base.restartWorkerProcess) throw new BridgeError(404, "not_found", "process not found");
      return base.restartWorkerProcess(projectId, procId);
    },
  };
}
