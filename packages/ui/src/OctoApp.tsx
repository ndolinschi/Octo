import type { ShellKind } from "@octo/agent-client";

export type OctoAppProps = {
  bridgeUrl: string;
  shell: ShellKind;
};

export function OctoApp({ bridgeUrl, shell }: OctoAppProps) {
  return (
    <main className="octo-app">
      <header>
        <h1>Octo Desktop</h1>
        <p className="octo-tagline">Shared UI — Phase 1 scaffold</p>
      </header>
      <section className="octo-panel">
        <dl>
          <div>
            <dt>Shell</dt>
            <dd>{shell}</dd>
          </div>
          <div>
            <dt>Harness bridge</dt>
            <dd>
              <code>{bridgeUrl}</code>
            </dd>
          </div>
        </dl>
        <p className="octo-hint">
          Agent chat arrives in Phase 2 when <code>harness serve</code> exposes the
          bridge API. Set <code>VITE_HARNESS_BRIDGE_URL</code> to point at the
          server.
        </p>
      </section>
    </main>
  );
}
