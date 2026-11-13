import type { Diagnostics } from "@octo/agent-client";

/**
 * R1.5: "Copy diagnostic report" — the harness's diagnostics as plain text to paste into an issue. The harness already
 * leaves secrets out (names of variables, never values); this adds nothing but the app's own version and the summary.
 */
export function diagnosticReport(d: Diagnostics, app: { bridgeUrl: string; shell: string }): string {
  const lines: string[] = [];
  lines.push(`Octo diagnostic report — ${d.generated_at}`);
  lines.push("");
  lines.push(`Harness ${d.version} (${d.go_version}, ${d.os}/${d.arch}); ${app.shell} shell; bridge ${app.bridgeUrl}`);
  lines.push(`Data folder: ${d.data_dir}`);
  lines.push(`PATH for agents: ${d.path_for_children}`);
  lines.push(`Variables set (names only): ${d.env_set.length ? d.env_set.join(", ") : "none"}`);
  lines.push(`Built-in loop: ${d.builtin_loop.available ? "available" : `unavailable — ${d.builtin_loop.reason ?? "no reason given"}`}`);
  lines.push(`Router: ${d.router.detected ? `detected at ${d.router.base_url} (${d.router.capabilities.join(", ") || "no capabilities"})` : "not detected"}`);
  lines.push(`ACP trace: ${d.acp_trace.enabled ? `on, ${d.acp_trace.files.length} file(s) in ${d.acp_trace.dir}` : "off"}`);
  lines.push("");
  lines.push("Agents:");
  if (d.agents.length === 0) lines.push("  none");
  for (const a of d.agents) {
    const login = !a.probe.ran
      ? "login not checked"
      : a.probe.logged_in === true
        ? "logged in"
        : a.probe.logged_in === false
          ? "not logged in"
          : "login unknown";
    const state = a.available ? login : `not available — ${a.unavailable_reason ?? "command not found"}`;
    lines.push(`  ${a.label} (${a.id}): ${a.command}; ${state}${a.probe.reason ? `; ${a.probe.reason}` : ""}`);
  }
  if (d.problems.length) {
    lines.push("");
    lines.push("Problems:");
    for (const p of d.problems) lines.push(`  - ${p}`);
  }
  lines.push("");
  lines.push(`Last ${d.log_tail.length} log lines:`);
  for (const l of d.log_tail) lines.push(`  ${l}`);
  return lines.join("\n");
}
