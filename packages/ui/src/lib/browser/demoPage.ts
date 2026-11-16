import { INSPECTOR_JS } from "./inspectorSource";

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Self-contained interactive web preview used in `?demo=1` (when no local service proxy exists).
 * Injects the exact same `INSPECTOR_JS` script as `apps/harness/internal/browserproxy/inspector.js`
 * so element picking, component stack badges, double-click text editing, live CSS overrides,
 * batch pins, and cropped screenshots behave identically in demo mode.
 */
export function buildDemoBrowserSrcdoc(rawUrl: string, nonce: string): string {
  let pathname = "/";
  let origin = "http://localhost:5173";
  try {
    const parsed = new URL(rawUrl);
    origin = parsed.origin;
    pathname = parsed.pathname || "/";
  } catch {
    pathname = "/";
  }
  const safeScript = INSPECTOR_JS.replace(/<\/script/gi, "<\\/script");
  const safeUrl = escapeAttr(`${origin}${pathname}`);
  const safeNonce = escapeAttr(nonce);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="octo-demo-url" content="${safeUrl}" />
  <title>Atlas Console — Local Preview</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.5;
    }
    .shell {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px 24px 56px;
    }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 16px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 15px;
      color: #0f172a;
    }
    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #2563eb;
    }
    .links {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-btn {
      border: 0;
      background: transparent;
      color: #475569;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .nav-btn[aria-current="page"] {
      background: #eff6ff;
      color: #1d4ed8;
    }
    .hero {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 24px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .eyebrow {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      color: #2563eb;
      background: #eff6ff;
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .sub {
      margin: 0 0 20px;
      color: #475569;
      font-size: 15px;
      max-width: 620px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .cta {
      border: 0;
      background: #2563eb;
      color: #ffffff;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .secondary {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #0f172a;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 20px;
    }
    .metric-label {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 6px;
    }
    .metric-value {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 4px;
    }
    .metric-delta {
      font-size: 12px;
      color: #16a34a;
      font-weight: 500;
    }
    .view[hidden] { display: none; }
  </style>
  <script data-octo-nonce="${safeNonce}">${safeScript}</script>
</head>
<body>
  <div class="shell" data-octo-component="AppLayout" data-octo-source="src/AppLayout.tsx">
    <header class="nav" data-octo-component="NavHeader" data-octo-source="src/components/NavHeader.tsx">
      <div class="brand">
        <span class="brand-dot"></span>
        <span id="brand-name">Atlas Billing</span>
      </div>
      <nav class="links" aria-label="Preview navigation">
        <button type="button" class="nav-btn" data-route="/" aria-current="page">Overview</button>
        <button type="button" class="nav-btn" data-route="/pricing">Pricing</button>
        <button type="button" class="nav-btn" data-route="/webhooks">Webhooks</button>
      </nav>
    </header>

    <main id="view-overview" class="view">
      <section id="hero" class="hero" data-octo-component="HeroBanner" data-octo-source="src/components/HeroBanner.tsx">
        <span class="eyebrow">Release 2.4</span>
        <h1 id="hero-title">Realtime usage billing without reconciliation drift</h1>
        <p class="sub">Inspect elements, edit copy with a double-click, tweak CSS properties live, or drag an area to attach visual notes directly to your session.</p>
        <div class="actions">
          <button id="primary-cta" type="button" class="cta">Start free trial</button>
          <button id="docs-cta" type="button" class="secondary">Read API guide</button>
        </div>
      </section>

      <section class="grid" data-octo-component="MetricGrid" data-octo-source="src/components/MetricGrid.tsx">
        <article class="card" data-octo-component="MetricCard" data-octo-source="src/components/MetricCard.tsx">
          <div class="metric-label">Settled volume (24h)</div>
          <div class="metric-value">$184,920</div>
          <div class="metric-delta">+12.4% vs yesterday</div>
        </article>
        <article class="card" data-octo-component="MetricCard" data-octo-source="src/components/MetricCard.tsx">
          <div class="metric-label">Webhook success rate</div>
          <div class="metric-value">99.98%</div>
          <div class="metric-delta">Median delivery 140 ms</div>
        </article>
        <article class="card" data-octo-component="MetricCard" data-octo-source="src/components/MetricCard.tsx">
          <div class="metric-label">Active subscriptions</div>
          <div class="metric-value">4,218</div>
          <div class="metric-delta">38 upgraded this week</div>
        </article>
      </section>
    </main>

    <main id="view-pricing" class="view" hidden>
      <section class="hero" data-octo-component="PricingSection" data-octo-source="src/components/PricingSection.tsx">
        <span class="eyebrow">Transparent tiers</span>
        <h1>Predictable pricing for growing teams</h1>
        <p class="sub">Every plan includes idempotent metering, automatic webhook retries, and audit exports.</p>
        <div class="grid">
          <article class="card" data-octo-component="PricingCard" data-octo-source="src/components/PricingCard.tsx">
            <div class="metric-label">Starter</div>
            <div class="metric-value">$49 / mo</div>
            <p class="sub">Up to 100k metered events per month.</p>
            <button type="button" class="cta">Choose Starter</button>
          </article>
          <article class="card" data-octo-component="PricingCard" data-octo-source="src/components/PricingCard.tsx">
            <div class="metric-label">Scale</div>
            <div class="metric-value">$249 / mo</div>
            <p class="sub">Unlimited events, dedicated webhook workers, and SOC2 reports.</p>
            <button type="button" class="cta">Upgrade to Scale</button>
          </article>
        </div>
      </section>
    </main>

    <main id="view-webhooks" class="view" hidden>
      <section class="hero" data-octo-component="WebhookPanel" data-octo-source="src/components/WebhookPanel.tsx">
        <span class="eyebrow">Event delivery</span>
        <h1>Webhook endpoints</h1>
        <p class="sub">Deliveries retry up to 5 times with exponential backoff before alerting on-call.</p>
        <div class="actions">
          <button type="button" class="cta">Add endpoint</button>
          <button type="button" class="secondary">Replay failed events</button>
        </div>
      </section>
    </main>
  </div>
  <script>
    (function () {
      var meta = document.querySelector('meta[name="octo-demo-url"]');
      var origin = "${escapeAttr(origin)}";
      function showRoute(route, push) {
        var views = {
          "/": "view-overview",
          "/pricing": "view-pricing",
          "/webhooks": "view-webhooks"
        };
        var id = views[route] || "view-overview";
        document.querySelectorAll(".view").forEach(function (el) {
          el.hidden = el.id !== id;
        });
        document.querySelectorAll("[data-route]").forEach(function (btn) {
          if (btn.getAttribute("data-route") === route) btn.setAttribute("aria-current", "page");
          else btn.removeAttribute("aria-current");
        });
        document.title = route === "/pricing"
          ? "Pricing — Atlas Console"
          : route === "/webhooks"
            ? "Webhooks — Atlas Console"
            : "Atlas Console — Local Preview";
        if (meta) meta.setAttribute("content", origin + route);
        if (push) {
          try { history.pushState({ route: route }, "", "#" + route); } catch (e) {}
        }
      }
      document.querySelectorAll("[data-route]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          showRoute(btn.getAttribute("data-route") || "/", true);
        });
      });
      window.addEventListener("popstate", function (ev) {
        var r = (ev.state && ev.state.route) || (location.hash ? location.hash.slice(1) : "/");
        showRoute(r, false);
      });
      showRoute(${JSON.stringify(pathname)}, false);
    })();
  </script>
</body>
</html>`;
}
