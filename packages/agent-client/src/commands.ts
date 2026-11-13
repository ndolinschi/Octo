/*
 * Project commands (UI decision 68): types of the harness commands API. Contract: apps/harness/docs/commands.md. Every
 * Bridge member that uses them is optional (HTTP bridge only). A command runs only when the user asks (the Run button);
 * no agent can start one.
 */

/** A named shell command of a project (`Project.commands`; a patch replaces the whole list). */
export type ProjectCommand = {
  /** Unique in the project, case-insensitive; no slashes. What the run route names. */
  name: string;
  /** Run by `bash -c` with the shell tool's environment rules. */
  command: string;
  /** A project folder's label, or a path relative to the first folder; with a review, relative to its worktree. "" = the first folder. */
  cwd?: string;
  /** A quiet button in the top row; at most two per project. */
  pinned?: boolean;
};

/** The project's review configuration (UI decision 78, project scope): `Project.review`, `Review.config`. */
export type ReviewConfig = {
  /** Names of project commands to offer on a pull request (the review header's "Run"). */
  commands: string[];
  /** Extra paths folded as mechanical in the reading order (`*` stays in a directory, `**` crosses, no `/` = any directory, trailing `/` = a directory). */
  mechanical_globs: string[];
  /** Diff view preference; `auto`: decide by width. */
  prefer: "split" | "unified" | "auto";
};
/** What a patch may carry: a review object replaces the whole configuration, missing fields take their defaults. */
export type ReviewConfigInput = Partial<ReviewConfig>;

/** A command the project's files suggest (never run unasked). */
export type CommandSuggestion = {
  name: string;
  /** The command line that would run it, e.g. `pnpm run dev`, `make build`, `just test`. */
  command: string;
  /** Label of the folder the file is in. */
  cwd: string;
  source: "package.json" | "Makefile" | "justfile";
  /** The project already has a command of this name. */
  configured: boolean;
};

export type CommandRunStatus = "running" | "finished" | "stopped" | "error";

export type CommandRun = {
  id: string;
  name: string;
  command: string;
  /** Absolute directory it ran in. */
  cwd: string;
  /** Set when it ran in a review's worktree. */
  review_id?: string;
  status: CommandRunStatus;
  /** Null while running; -1 when a signal ended the process (stopped). */
  exit_code: number | null;
  started_at: string;
  finished_at?: string;
  duration_ms: number;
  output_bytes: number;
  /** The output went past 5 MB and the rest was dropped. */
  truncated: boolean;
  /** The end of the output (stdout and stderr in arrival order, at most 64 KiB); only on `getCommandRun`. */
  tail?: string;
};

/** `POST …/commands/{name}/run` → 201. */
export type StartedCommandRun = { run_id: string; run: CommandRun };

/** A run tied to a review (`Review.meta.runs`, newest first). */
export type ReviewRunRef = {
  id: string;
  name: string;
  status: CommandRunStatus;
  exit_code: number | null;
  started_at: string;
  finished_at?: string;
};

/** `command.started`: a run began. */
export type CommandStartedEvent = { type: "command.started"; seq: number; run: CommandRun };
/** `command.output`: a chunk of a run's output (at most 16 KiB, whole characters; 5 MB per run, then a marker). */
export type CommandOutputEvent = { type: "command.output"; seq: number; run_id: string; stream: "stdout" | "stderr"; text: string };
/** `command.finished`: a run ended. */
export type CommandFinishedEvent = {
  type: "command.finished";
  seq: number;
  run_id: string;
  exit_code: number;
  duration_ms: number;
  status: CommandRunStatus;
  name: string;
  review_id?: string;
};
