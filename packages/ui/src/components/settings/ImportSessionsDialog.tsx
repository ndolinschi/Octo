import type { ImportSessionRef, ImportableSession } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { errorMessage, formatRelative, middleTruncate, structuredError } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Dialog } from "../primitives/Dialog";
import { Notice } from "../primitives/Notice";
import { Select } from "../primitives/Select";
import { SkeletonList } from "../primitives/Skeleton";
import { TextField } from "../primitives/TextField";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: ImportableSession[] };

const keyOf = (s: Pick<ImportableSession, "provider" | "id">) => `${s.provider}:${s.id}`;

/**
 * Discovers conversations from local AI CLI tools (Claude Code, Codex, Gemini, OpenCode),
 * matches them to Octo projects by folder, and imports the selected transcripts.
 */
export function ImportSessionsDialog(props: { onClose(): void; onImported(count: number, skipped: number): void }) {
  const { bridge, projects, refreshProjects } = useApp();
  const activity = useActivity();
  const now = useNow(false, CLOCK_MINUTE_MS);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [targets, setTargets] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const list = bridge.listImportableSessions;
    if (!list) {
      setLoad({ status: "error", message: "This version of Octo's local service cannot scan external sessions." });
      return;
    }
    let live = true;
    setLoad({ status: "loading" });
    void list().then(
      (items) => {
        if (!live) return;
        setLoad({ status: "ready", items });
      },
      (e: unknown) => {
        if (!live) return;
        setLoad({ status: "error", message: structuredError(e)?.message ?? errorMessage(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, attempt]);

  const projectOptions = useMemo(() => (projects ?? []).map((p) => ({ value: p.id, label: p.name })), [projects]);
  const fallbackProjectId = projects?.[0]?.id ?? "";

  const filtered = useMemo(() => {
    if (load.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return load.items;
    return load.items.filter((s) => `${s.title} ${s.provider_label} ${s.cwd} ${s.preview}`.toLowerCase().includes(q));
  }, [load, query]);

  const newItems = useMemo(() => (load.status === "ready" ? load.items.filter((s) => !s.already_imported) : []), [load]);
  const selectableVisible = useMemo(() => filtered.filter((s) => !s.already_imported), [filtered]);
  const targetOf = (s: ImportableSession) => targets.get(keyOf(s)) ?? s.matched_project_id ?? fallbackProjectId;

  const toggle = (key: string, next: boolean) => {
    setSelected((cur) => {
      const copy = new Set(cur);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  };

  const selectAllNew = () => {
    setSelected(new Set(selectableVisible.map(keyOf)));
  };

  const handleImport = async () => {
    if (load.status !== "ready" || !bridge.importSessions || selected.size === 0 || !fallbackProjectId) return;
    setSubmitError(null);
    setBusy(true);
    try {
      const byProject = new Map<string, ImportSessionRef[]>();
      for (const s of load.items) {
        if (s.already_imported || !selected.has(keyOf(s))) continue;
        const pid = targetOf(s);
        if (!pid) continue;
        const list = byProject.get(pid) ?? [];
        list.push({ provider: s.provider, id: s.id });
        byProject.set(pid, list);
      }
      let importedCount = 0;
      let skippedCount = 0;
      for (const [pid, refs] of byProject) {
        const res = await bridge.importSessions(pid, refs);
        importedCount += res.imported.length;
        skippedCount += res.skipped;
      }
      activity.refreshSessions();
      await refreshProjects();
      window.dispatchEvent(new CustomEvent("octo:sessions-reset", { detail: { cleared: false } }));
      props.onImported(importedCount, skippedCount);
      props.onClose();
    } catch (e) {
      setSubmitError(structuredError(e)?.message ?? errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = load.status === "ready";
  const hasProjects = projectOptions.length > 0;

  return (
    <Dialog
      title="Import sessions"
      description="Bring past conversations from Claude Code, Codex, Gemini, and OpenCode into your Octo projects."
      onClose={() => !busy && props.onClose()}
      width="lg"
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready || !hasProjects || selected.size === 0} onClick={() => void handleImport()}>
            {selected.size > 0 ? `Import (${selected.size})` : "Import"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!hasProjects && ready && <Notice tone="warn">Create a project first so imported sessions have a project to live in.</Notice>}
        {submitError && <Notice tone="error">{submitError}</Notice>}
        {load.status === "loading" && <SkeletonList count={4} size="lg" twoLine />}
        {load.status === "error" && (
          <Notice
            tone="error"
            action={
              <Button size="xs" variant="quiet" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            {load.message}
          </Notice>
        )}
        {ready && load.items.length === 0 && (
          <p className="py-6 text-center text-sm text-fg-3">No conversations found in Claude Code, Codex, Gemini, or OpenCode on this machine.</p>
        )}
        {ready && load.items.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <TextField
                size="sm"
                aria-label="Filter sessions to import"
                placeholder="Filter by title, folder, or provider"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-44 flex-1"
              />
              <Button size="sm" variant="quiet" disabled={selectableVisible.length === 0} onClick={selectAllNew}>
                Select new ({newItems.length})
              </Button>
              {selected.size > 0 && (
                <Button size="sm" variant="quiet" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              )}
            </div>
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-3">No sessions match &ldquo;{query}&rdquo;.</p>
            ) : (
              <ul aria-label="Importable sessions" className="divide-y divide-line rounded-lg border border-line bg-panel">
                {filtered.map((s) => {
                  const key = keyOf(s);
                  const checked = selected.has(key);
                  const pid = targetOf(s);
                  const countText = s.exchange_count === 1 ? "1 exchange" : `${s.exchange_count} exchanges`;
                  const when = formatRelative(s.updated_at || s.started_at, now);
                  return (
                    <li key={key} data-import-row={key} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-start gap-2">
                          <Checkbox
                            checked={checked}
                            disabled={s.already_imported || !hasProjects || busy}
                            onChange={(next) => toggle(key, next)}
                            label={
                              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                <span className="min-w-0 font-medium text-fg">{s.title || "Untitled session"}</span>
                                <span className="rounded-xs bg-raised px-1.5 py-0.5 text-xs text-fg-2">{s.provider_label}</span>
                                {s.already_imported && <span className="rounded-xs bg-raised px-1.5 py-0.5 text-xs text-fg-3">Imported</span>}
                              </span>
                            }
                          />
                        </div>
                        <div className="mt-1 pl-6 text-xs text-fg-3">
                          <span>
                            {countText}
                            {when ? ` · ${when}` : ""}
                            {s.cwd ? ` · ${middleTruncate(s.cwd, 44)}` : ""}
                          </span>
                          {s.preview && <p className="mt-0.5 line-clamp-2 text-fg-2">{s.preview}</p>}
                        </div>
                      </div>
                      {hasProjects && (
                        <div className="shrink-0 pl-6 sm:w-44 sm:pl-0">
                          <Select
                            size="sm"
                            label={`Project for ${s.title || "session"}`}
                            value={pid}
                            disabled={s.already_imported || busy}
                            options={projectOptions}
                            onChange={(nextPid) =>
                              setTargets((cur) => {
                                const copy = new Map(cur);
                                copy.set(key, nextPid);
                                return copy;
                              })
                            }
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
