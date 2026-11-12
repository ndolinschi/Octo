import { Globe } from "lucide-react";
import { lazy, Suspense } from "react";
import type { Approval } from "@octo/agent-client";
import { splitPath } from "../../lib/v7/changes";
import { hostOf } from "../../lib/v7/patch";
import { Glyph } from "../primitives/Glyph";
import { DiffBar, LineCounts } from "./parts";

/** Opened only on a click or an expand, so it stays out of the entry chunk (bundle budget). */
const PatchView = lazy(() => import("./ApprovalExtras").then((m) => ({ default: m.PatchView })));

/** The thing to approve: a path with its line counts and changes, a command in mono, a web page, or the ACP tool's title. */
export function ApprovalSubject({ approval }: { approval: Approval }) {
  const { detail } = approval;
  const path = detail.path ? splitPath(detail.path) : null;
  return (
    <>
      {approval.kind === "acp" && <p className="min-w-0 [overflow-wrap:anywhere] text-fg">{approval.title}</p>}
      {approval.kind === "network" && <NetworkSubject approval={approval} />}
      {detail.command !== undefined && (
        <pre className="octo-code max-h-40 overflow-auto rounded-sm bg-code-bg px-3 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
          <span className="text-fg-3 select-none">$ </span>
          {detail.command}
        </pre>
      )}
      {path && (
        <div className="flex min-h-7 min-w-0 items-center gap-2 rounded-sm bg-code-bg px-3 py-1 font-mono text-xs">
          <span className="min-w-0 truncate" title={`${detail.folder ? `${detail.folder}/` : ""}${detail.path ?? ""}`}>
            {path.dir && <span className="text-fg-3">{path.dir}/</span>}
            <span className="text-fg">{path.name}</span>
          </span>
          {detail.diff && (
            <span className="ml-auto flex shrink-0 items-center gap-2 font-sans">
              <LineCounts added={detail.diff.added} removed={detail.diff.removed} />
              <DiffBar added={detail.diff.added} removed={detail.diff.removed} />
            </span>
          )}
        </div>
      )}
      {detail.patch && (
        <Suspense fallback={<div className="h-6" />}>
          <PatchView patch={detail.patch} />
        </Suspense>
      )}
      {approval.kind === "write" && !path && <p className="[overflow-wrap:anywhere] text-fg">{approval.title}</p>}
    </>
  );
}

/** Parity B2: a web_fetch in a supervised project — the host first, then the whole URL, and what the agent said it is for. */
function NetworkSubject({ approval }: { approval: Approval }) {
  const url = approval.detail.url ?? "";
  const host = hostOf(url);
  // The title is the agent's own line about the fetch; it is only shown when it says more than the URL.
  const why = approval.title.trim() !== "" && approval.title !== url && approval.title !== `Fetch ${url}` ? approval.title : null;
  return (
    <div data-network className="flex min-w-0 flex-col gap-1.5">
      <p className="flex min-w-0 items-center gap-2 text-fg">
        <Glyph icon={Globe} size={14} className="shrink-0 text-fg-3" />
        <span className="min-w-0 truncate" title={host}>
          {host}
        </span>
      </p>
      {url && (
        <pre className="octo-code max-h-24 overflow-auto rounded-sm bg-code-bg px-3 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">{url}</pre>
      )}
      {why && <p className="min-w-0 [overflow-wrap:anywhere] text-fg-2">{why}</p>}
    </div>
  );
}
