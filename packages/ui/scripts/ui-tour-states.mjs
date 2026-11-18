/**
 * The states of the UI tour (see ui-tour.mjs). Each state: `name` (file name part), `text` (one line for INDEX.md), `sizes`
 * ("all" = four window sizes, else 1440x900 only) and `run(page, env)` that drives a fresh page into the state. A `run` that
 * cannot reach its state throws; the tour records that in MISSING.txt and saves nothing.
 */

/* ---------- helpers ---------- */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the demo; `q` is the whole query string (default `demo=1`), `hash` the route. The tour shows every screen, so a demo
 * query without a `tabs` knob gets `tabs=all`: the default flags (`lib/tabFlags.ts`) hide the Sessions, Agents, Notes,
 * Details, Usage and Memory tabs, and the states that open them would never be reached. A state about the default experience
 * passes its own `tabs=` (an empty `tabs=` keeps the defaults) and is left alone.
 */
async function boot(page, env, q = "demo=1", hash = "") {
  if (/^demo=/.test(q) && !/(^|&)tabs=/.test(q)) q += "&tabs=all";
  await page.goto(`${env.base}/?${q}${hash}`);
  await page.locator("body").waitFor();
  await page.waitForTimeout(1200);
}

async function menuButton(page) {
  const b = page.getByRole("button", { name: /^(Show|Open) sidebar$|^Menu$/ }).first();
  if (await b.isVisible().catch(() => false)) await b.click();
  await page.waitForTimeout(300);
}

/** Clicks a project in the sidebar (opening the drawer first on a narrow window). */
async function project(page, env, name) {
  const item = page.locator("a", { hasText: name }).first();
  if (!(await item.isVisible().catch(() => false))) await menuButton(page);
  await item.click({ timeout: 8000 });
  await page.waitForTimeout(1200);
}

async function home(page) {
  const b = page.getByRole("button", { name: "Home" }).first();
  if (!(await b.isVisible().catch(() => false))) await menuButton(page);
  await b.click();
  await page.waitForTimeout(900);
}

/** Ctrl+K, type, pick the first result with Enter. */
async function palette(page, text, pick = true) {
  await page.keyboard.press("Control+k");
  const box = page.getByRole("combobox", { name: /^Search (tabs|or run an action)/ }).first();
  await box.waitFor({ timeout: 6000 });
  if (text) await box.fill(text);
  await page.waitForTimeout(500);
  if (pick) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
  }
}

const tool = (page, label) => palette(page, label);

const composer = (page) => page.locator("#octo-composer, #octo-composer-float").first();

async function send(page, text) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.keyboard.press("Enter");
}

const click = async (page, name, opts = {}) => {
  const b = page.getByRole("button", { name, ...opts }).first();
  await b.click({ timeout: 8000 });
  await page.waitForTimeout(500);
};

/** Presses "Restore to here" under the newest reply that has one (R2 checkpoints; shown on hover under a reply without changes). */
async function openRewind(page) {
  const reply = page.locator("article:has(button[data-restore])").last();
  await reply.scrollIntoViewIfNeeded();
  await reply.hover();
  await reply.locator("button[data-restore]").last().click({ timeout: 8000 });
}

/** Files tool, then a file of the tree by name. */
async function openFile(page, name) {
  await tool(page, "Show files");
  const row = page
    .getByRole("treeitem", { name })
    .or(page.getByText(name, { exact: true }))
    .filter({ visible: true })
    .first();
  await row.click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

/** Opens `src/auth/refresh.ts`-style paths from the Files tree, expanding each folder. */
async function openPath(page, parts) {
  await tool(page, "Show files");
  // The file tree by its name: the sidebar's "Projects and sessions" tree comes first in the page.
  const tree = page.getByRole("tree", { name: /files/i }).filter({ visible: true }).first();
  await tree.waitFor({ timeout: 8000 });
  for (let i = 0; i < parts.length; i++) {
    const row = tree.getByText(parts[i], { exact: true }).first();
    await row.click({ timeout: 8000 });
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
}

async function editorReady(page) {
  await need(page, page.locator(".monaco-editor .view-line"), "editor text", 20000);
  await page.waitForTimeout(600);
}

/** Clicks a visible control by its text (tabs that are not buttons). */
const clickText = async (page, text) => {
  await page.getByText(text).filter({ visible: true }).last().click({ timeout: 8000 });
  await page.waitForTimeout(500);
};

/** Review tab of Atlas API: the picker (list loaded). */
async function reviewPicker(page, env, q = "demo=1") {
  await boot(page, env, q);
  await project(page, env, "Atlas API");
  await tool(page, "Review a pull request");
}

/** Review tab with the pull request #482 open and its diff drawn. */
async function reviewOpen(page, env) {
  await reviewPicker(page, env);
  const row = page.getByText("Retry transient 5xx").first();
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await need(page, page.getByRole("button", { name: "Submit review" }), "open pull request", 20000);
  await need(page, page.getByText("import { BillingError }"), "diff drawn", 20000);
  await page.waitForTimeout(600);
}

/** Opens the project settings dialog from the project's "⋯" menu. */
async function projectSettings(page) {
  await click(page, /^Project actions$/);
  await page.getByRole("menuitem", { name: /Project settings/ }).click();
  await need(page, page.getByRole("dialog"), "project settings dialog");
  await page.waitForTimeout(800);
}

const need = async (page, locator, what, timeout = 8000) => {
  try {
    await locator.filter({ visible: true }).first().waitFor({ timeout });
  } catch {
    throw new Error(`not reached: ${what}`);
  }
};

/** Files tool, then a file by its tree path ("folder/dir/file"), expanding only the folders that are closed. */
async function openTreePath(page, path) {
  await tool(page, "Show files");
  const tree = page.getByRole("tree", { name: "Project files" }).filter({ visible: true }).first();
  await tree.waitFor({ timeout: 8000 });
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const row = tree.locator(`[role="treeitem"][data-path="${parts.slice(0, i).join("/")}"]`).first();
    if ((await row.count()) && (await row.getAttribute("aria-expanded")) === "false") {
      await row.click({ timeout: 8000 });
      await page.waitForTimeout(400);
    }
  }
  await tree.locator(`[role="treeitem"][data-path="${path}"]`).first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

/* ---------- groups ---------- */

export const GROUPS = {
  "first-run": [
    {
      name: "connect-screen",
      text: "No provider is connected (?providers=none): the connect screen on Home.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=1&providers=none");
        await home(page);
        await need(page, page.getByText(/connect/i), "connect screen");
      },
    },
    {
      name: "no-projects",
      text: "No projects yet (?demo=empty): the first-run hero.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=empty");
        await need(page, page.getByRole("button", { name: /Create project|New project/ }), "no-projects hero");
      },
    },
    {
      name: "new-project-dialog",
      text: "The New project dialog (name, description, instructions, folder, models).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=empty");
        await page
          .getByRole("button", { name: /Create project|New project/ })
          .filter({ visible: true })
          .first()
          .click();
        await need(page, page.getByRole("dialog"), "dialog");
      },
    },
    {
      name: "folder-picker",
      text: "New project dialog with the in-app folder picker open.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=empty");
        await page
          .getByRole("button", { name: /Create project|New project/ })
          .filter({ visible: true })
          .first()
          .click();
        await click(page, /Choose a folder/);
        await need(page, page.getByText(/Browse/), "folder picker");
      },
    },
    {
      name: "folder-picker-browse-busy",
      busy: true,
      text: "Folder picker with the system dialog's Browse button busy (time frozen right after the click).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=empty");
        await page
          .getByRole("button", { name: /Create project|New project/ })
          .filter({ visible: true })
          .first()
          .click();
        await click(page, /Choose a folder/);
        const browse = page.getByText(/Browse/).first();
        await browse.waitFor({ timeout: 6000 });
        // Fake time, paused: the 400 ms the demo's folder dialog takes never passes, so the busy row stays.
        await page.clock.install();
        await page.clock.pauseAt(new Date(Date.now() + 1000));
        await browse.click();
        await page.waitForTimeout(300);
        const busy = await page.locator("[aria-busy='true']:visible").count();
        if (busy === 0) throw new Error("Browse did not show a busy state");
      },
    },
  ],

  home: [
    {
      name: "default",
      text: "Home with the ten demo projects.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await home(page);
        await need(page, page.getByText(/What should we work on/), "home");
      },
    },
    {
      name: "one-project",
      text: "Home with a single project (?demo=one).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=one");
        await home(page);
      },
    },
    {
      name: "many-projects",
      text: "Home with many projects (?demo=many).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=many");
        await home(page);
      },
    },
  ],
  chat: [
    {
      name: "empty-conversation",
      text: "A project with no requests yet (Design system tokens).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Design system tokens");
        await need(page, composer(page), "composer");
      },
    },
    {
      name: "turn-running-live-activity",
      text: "Docs site, 'live activity please' sent: thinking, plan, tool rows and streaming text while the turn runs.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "live activity please");
        await need(page, page.getByRole("button", { name: /^Stop( the turn| \(|$)/ }), "running turn");
        await page.waitForTimeout(4200);
      },
    },
    {
      name: "sub-agents-delegation",
      text: "Orbit mobile: the orchestrator delegating to sub-agents (team chips in the tab strip, delegation rows).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Orbit mobile");
        await page.waitForTimeout(2500);
        await need(page, page.getByText(/Dependency auditor/), "delegation");
      },
    },
    {
      name: "approval-command",
      text: "Atlas API: an approval card asking to run a command (Allow once / for this turn / Deny).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        const card = page.locator("[data-v7-approval]").last();
        await need(page, card, "approval card");
        await card.scrollIntoViewIfNeeded();
      },
    },
    {
      name: "approval-edit-patch-open",
      text: "Docs site, 'approvals demo please': an edit approval with its patch expanded.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "approvals demo please");
        await need(page, page.locator("[data-v7-approval-group], [data-v7-approval]").first(), "approvals");
        await page.waitForTimeout(500);
        await page.getByRole("button", { name: "Details" }).first().click();
        await need(page, page.locator("[data-patch]"), "patch");
        await page.locator("[data-patch]").first().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "approval-network",
      text: "Docs site: the network (web fetch) approval card with host and URL.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "approvals demo please");
        await need(page, page.locator("[data-v7-approval-group], [data-v7-approval]").first(), "network approval");
        await page.waitForTimeout(500);
        await page.getByRole("button", { name: "Details" }).nth(1).click();
        await need(page, page.locator("[data-network]"), "network details");
        await page.locator("[data-network]").first().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "always-allow-panel",
      text: "Docs site: 'Always allow' opened on an approval: the exact rule before it is saved.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "approvals demo please");
        await need(page, page.locator("[data-v7-approval-group], [data-v7-approval]").first(), "approvals");
        await page.waitForTimeout(500);
        await page
          .getByRole("button", { name: /^Always allow/ })
          .last()
          .click();
        await need(page, page.locator("[data-always-panel]"), "rule panel");
      },
    },
    {
      name: "form-card",
      text: "Atlas API: the agent's input form card (text, secret, choice, checkbox).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        const t = page.getByText("Deploy settings").first();
        await need(page, t, "form card");
        await t.scrollIntoViewIfNeeded();
      },
    },
    {
      name: "queue-with-steer",
      text: "Docs site: a running turn with a queued message; the queue row offers Send now and Stop and send.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "live activity please");
        await need(page, page.getByRole("button", { name: /^Stop( the turn| \(|$)/ }), "running turn");
        await page.waitForTimeout(800);
        await send(page, "Then summarise the result in one line");
        await need(page, page.getByRole("button", { name: /Send now/ }), "queue row with Send now");
      },
    },
    {
      name: "plan-card-pending",
      text: "Release notes in Plan mode: the turn ended with a plan card waiting (Approve and run / Keep editing).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Release notes");
        const box = composer(page);
        await box.click();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        await box.fill("plan the release checklist");
        await page.keyboard.press("Enter");
        await need(page, page.locator("[data-plan=pending]"), "pending plan card", 40000);
        await page.locator("[data-plan=pending]").first().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "plan-card-approved",
      text: "The same plan after 'Approve and run': folded to one line.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Release notes");
        const box = composer(page);
        await box.click();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        await box.fill("plan the release checklist");
        await page.keyboard.press("Enter");
        await need(page, page.locator("[data-plan=pending]"), "pending plan card", 40000);
        await click(page, /Approve and run/);
        await need(page, page.locator("[data-plan=approved]"), "approved plan card", 20000);
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "failed-turn-login",
      text: "Changelog bot: the agent could not start (not logged in); the failure and the command to run.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Changelog bot");
        await need(page, page.locator("[data-turn-outcome='failed']"), "failed banner");
      },
    },
    {
      name: "stopped-turn",
      text: "Docs site: a running turn stopped by the person (Stopped banner).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "live activity please");
        await click(page, /^Stop( the turn| \(|$)/);
        await need(page, page.getByText(/Stopped|stopped/), "stopped banner", 12000);
      },
    },
    {
      name: "failed-turn",
      text: "Billing webhooks: a turn that failed in the middle of a conversation.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Billing webhooks");
        await need(page, page.locator("[data-turn-outcome='failed']"), "failed banner");
        await page.locator("[data-turn-outcome='failed']").last().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "rewind-dialog-clean",
      text: "Docs site: 'Rewind to here' dialog after its dry run: files restored, conversation cut, nothing blocking.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await openRewind(page);
        await need(page, page.locator("[data-rewind]"), "rewind dialog");
        await page.waitForTimeout(800);
      },
    },
    {
      name: "rewind-dialog-conflict",
      text: "Atlas API: after Rewind is pressed a file blocks it (src/stale.ts); the dialog lists it with the reason.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openRewind(page);
        await need(page, page.locator("[data-rewind]"), "rewind dialog");
        await page.waitForTimeout(800);
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^(Restore|Rewind)$/ })
          .click();
        await need(page, page.getByText("src/stale.ts"), "conflict list", 8000);
        await page.waitForTimeout(500);
      },
    },
    {
      name: "rewound-marker",
      text: "Docs site after a rewind: the transcript is cut and a quiet 'Rewound to here' line stays.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await openRewind(page);
        await need(page, page.locator("[data-rewind]"), "rewind dialog");
        await page.waitForTimeout(800);
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^(Restore|Rewind)$/ })
          .click();
        await need(page, page.locator("[data-rewound]"), "rewound marker", 8000);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(500);
      },
    },
    {
      name: "compacted-marker",
      text: "Docs site after 'Compact now' in the context popover: the 'History compacted' line.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await click(page, /^Context:/);
        await click(page, /Compact now/);
        await need(page, page.locator("[data-compacted]"), "compacted marker", 10000);
        await page.keyboard.press("Escape");
        await page.locator("[data-compacted]").first().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "narrow-conversation-beside-editor",
      text: "Docs site with a file open beside the conversation: the conversation at its narrow layout.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await openFile(page, "package.json");
      },
    },
  ],

  composer: [
    {
      name: "empty",
      text: "Release notes: the composer with no text.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Release notes");
        await composer(page).click();
      },
    },
    {
      name: "long-prompt",
      text: "A 12-line prompt: the box grows and then scrolls; the layout around it holds.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Release notes");
        const lines = Array.from(
          { length: 12 },
          (_, i) => `${i + 1}. Check that the changelog entry for the ${["API", "web", "docs", "CLI"][i % 4]} package mentions the new retry policy.`,
        );
        await composer(page).fill(lines.join("\n"));
      },
    },
    {
      name: "mentions-and-commands-highlighted",
      text: "Text with an @file mention and /commands tinted by the highlight layer.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await composer(page).fill("Compare @src/auth/refresh.ts with @src/lib/session.ts, then run /files and /settings now");
        await page.waitForTimeout(800);
        await need(page, page.locator("[data-composer-highlight] mark"), "highlight marks");
      },
    },
    {
      name: "model-picker-level-1",
      text: "Docs site: the model picker's first level (agents, not connected).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await click(page, /^Model:/);
        await need(page, page.getByPlaceholder("Search models and agents"), "model picker");
      },
    },
    {
      name: "model-picker-level-2-models",
      text: "The picker's second level for Claude Code: the agent's models.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await click(page, /^Model:/);
        await page.getByText("Claude Code").filter({ visible: true }).first().click();
        await page.waitForTimeout(700);
        await need(page, page.getByText(/Opus|Haiku/), "model list");
      },
    },
    {
      name: "model-picker-level-2-empty",
      text: "The second level for an agent with no models listed: the empty state with its reason.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=1&claude=empty");
        await project(page, env, "Docs site");
        await click(page, /^Model:/);
        await page.getByText("Claude Code").filter({ visible: true }).first().click();
        await page.waitForTimeout(900);
      },
    },
    {
      name: "model-picker-other-model",
      text: "The second level with the 'Other model' text input open.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await click(page, /^Model:/);
        await page.getByText("Claude Code").filter({ visible: true }).first().click();
        await page.waitForTimeout(700);
        await page
          .getByText(/Other model/)
          .filter({ visible: true })
          .first()
          .click();
        await page.waitForTimeout(500);
        await need(page, page.locator("input:visible").last(), "other model input");
      },
    },
    {
      name: "mode-menu",
      text: "The mode chip's menu: Agent / Ask / Plan and 'Make default'.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await click(page, /^Mode:/);
        await need(page, page.getByRole("menu"), "mode menu");
      },
    },
    {
      name: "folder-chip-menu",
      text: 'The folders menu, opened from the + menu\'s "Folders" entry (project folders and add).',
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await page.locator('[data-composer] [aria-haspopup="listbox"]').first().click();
        await page.waitForTimeout(300);
        await page
          .locator('[data-composer-menu] [role="option"]', { hasText: /^Folders:/ })
          .first()
          .click();
        await page.waitForTimeout(500);
      },
    },
    {
      name: "context-popover-harness",
      text: "Docs site (built-in loop): the context popover with meter, Compact now and details.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await click(page, /^Context:/);
        await need(page, page.getByText("Compact now"), "context popover");
      },
    },
    {
      name: "context-popover-agent",
      text: "Atlas API (ACP agent): the context popover as an agent reports it.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await click(page, /^Context:/);
        await page.waitForTimeout(700);
        await need(page, page.getByRole("dialog").or(page.getByRole("meter")), "context popover");
      },
    },
    {
      name: "project-selector-closed",
      text: "Design system tokens (an empty session): the project selector above the composer, closed.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Design system tokens");
        await need(page, page.locator("[data-project-selector]"), "project selector");
      },
    },
    {
      name: "project-selector-open",
      text: "The composer's project selector open: every project with its state and when it last changed, the current one checked.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Design system tokens");
        await page.locator("[data-project-selector]").filter({ visible: true }).first().click({ timeout: 8000 });
        await need(page, page.getByPlaceholder("Switch project…"), "the project list");
        await page.waitForTimeout(400);
      },
    },
  ],

  files: [
    {
      name: "tree",
      text: "Atlas API: the Files tool with its folder tree.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show files");
        const tree = page.getByRole("tree", { name: /files/i }).filter({ visible: true }).first();
        await need(page, tree, "file tree");
        await tree.getByText("src", { exact: true }).first().click();
        await page.waitForTimeout(500);
      },
    },
    {
      name: "file-open",
      text: "src/auth/refresh.ts open in the editor beside the conversation (syntax colours, tabs).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openPath(page, ["src", "auth", "refresh.ts"]);
        await editorReady(page);
      },
    },
    {
      name: "wide-file",
      text: "width/wide.txt: lines far wider than the editor (horizontal scroll, no layout change).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openPath(page, ["width", "wide.txt"]);
        await editorReady(page);
      },
    },
    {
      name: "inline-completion-ghost-text",
      text: "Typing 'function cl' in an open file: the grey inline completion suggestion.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openPath(page, ["src", "auth", "refresh.ts"]);
        await editorReady(page);
        await page.locator(".monaco-editor").first().click();
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type("function cl", { delay: 40 });
        await need(page, page.locator(".ghost-text, .ghost-text-decoration, .inline-suggestion-text"), "ghost text", 15000);
        await page.waitForTimeout(500);
      },
    },
    {
      name: "comments-on-a-file",
      text: "A pending code comment under a line (and its composer closed).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openPath(page, ["src", "auth", "refresh.ts"]);
        await editorReady(page);
        await page
          .locator(".monaco-editor .view-line")
          .nth(4)
          .click({ position: { x: 4, y: 8 } });
        await page.keyboard.press("Control+Alt+c");
        const box = page.getByPlaceholder(/Comment on/);
        await box.waitFor({ timeout: 6000 });
        await box.fill("Why is the grace window 30 seconds here? The web client refreshes 60 s early.");
        await page
          .getByRole("button", { name: /^(Add|Save|Comment)/ })
          .filter({ visible: true })
          .last()
          .click();
        await need(page, page.getByLabel(/Pending comment on/), "pending comment card");
      },
    },
  ],

  side: [
    {
      name: "changes-list-and-diff",
      text: "Atlas API: the Changes tool with a changed file's diff open next to the list.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show changes");
        await need(page, page.getByText("format.ts"), "changes list");
        await page.getByText("format.ts", { exact: true }).first().click();
        await page.waitForTimeout(1200);
        await need(page, page.locator(".monaco-diff-editor, .monaco-editor, [data-diff]"), "diff", 20000);
        await page.waitForTimeout(800);
      },
    },
    {
      name: "memory-tasks",
      text: "Atlas API: the Memory tool, Knowledge view (what is remembered, and the tasks).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Knowledge" }).click();
        await need(page, page.getByText("Refresh tokens rotate on every use"), "memory knowledge");
      },
    },
    {
      name: "memory-facts",
      text: "The Memory tool's Files view (what the project remembers about its files).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Files" }).click();
        await page.waitForTimeout(800);
      },
    },
    {
      name: "memory-search",
      text: "The Memory tool's Search view with a query and results.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page
          .getByRole("searchbox")
          .or(page.getByPlaceholder(/Search/))
          .first()
          .fill("refresh");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "agents",
      text: "Atlas API: the Agents tool (six sub-agents, their status and work).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show agents");
        await page.waitForTimeout(800);
      },
    },
    {
      name: "usage",
      text: "Atlas API: the Usage tool (tokens, cost, limits).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show usage");
        await page.waitForTimeout(800);
      },
    },
    {
      name: "notes",
      text: "Atlas API: the Notes tool with the notes the agents saved.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show notes");
        await page.waitForTimeout(800);
      },
    },
    ...[
      ["changes", "Show changes"],
      ["memory", "Show memory"],
      ["agents", "Show agents"],
      ["usage", "Show usage"],
      ["notes", "Show notes"],
    ].map(([n, cmd]) => ({
      name: `${n}-empty`,
      text: `Design system tokens (no requests yet): the ${n} tool's empty state.`,
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, n === "memory" ? "demo=1&memory=empty" : "demo=1");
        await project(page, env, "Design system tokens");
        await tool(page, cmd);
        await page.waitForTimeout(900);
      },
    })),
  ],

  "dock-tools": [
    {
      name: "terminal",
      text: "Atlas API, Terminal tab: the interactive shell with its prompt (zsh, PID, working folder).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Open terminal");
        await need(page, page.locator("[data-terminal-tab] [data-terminal-screen]"), "terminal screen", 15000);
        await need(page, page.getByText(/maya@octo/), "the shell prompt", 15000);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "terminal-second",
      text: "Atlas API: a second terminal tab opened beside the first (Ctrl+Shift+`), both tabs in the strip.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Open terminal");
        await need(page, page.locator("[data-terminal-tab] [data-terminal-screen]"), "terminal screen", 15000);
        await page.keyboard.press("Control+Shift+`");
        await page.waitForTimeout(1200);
        const terminals = await page.locator('[role="tab"][data-tab-id*="terminal"]').count();
        if (terminals < 2) throw new Error(`not reached: a second terminal tab (${terminals} terminal tabs)`);
        await need(page, page.getByText(/maya@octo/), "the second shell prompt", 15000);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "browser-empty",
      text: "Atlas API, Browser tab before any page: the address field and the hint to enter a localhost port or URL.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show browser");
        await need(page, page.locator("[data-browser-tab]"), "browser tab", 15000);
        await need(page, page.getByText(/Open a local preview or web page/), "the empty browser hint");
      },
    },
    {
      name: "browser-loaded",
      text: "Atlas API, Browser tab with http://localhost:5173 loaded (the demo's local preview page).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show browser");
        await need(page, page.locator("[data-browser-tab]"), "browser tab", 15000);
        await page.getByLabel("Page URL").filter({ visible: true }).first().fill("http://localhost:5173");
        await page.keyboard.press("Enter");
        await need(page, page.locator("[data-browser-tab] iframe"), "the loaded page", 15000);
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "processes-populated",
      text: "Atlas API, Processes tab: the seeded dev server, test run and workers, the first one's live output on the right.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show processes");
        await need(page, page.locator("[data-processes] [data-row]"), "a process row", 15000);
        await page.waitForTimeout(800);
      },
    },
    {
      name: "processes-empty",
      text: "Design system tokens, Processes tab: no command has run (the empty state with its way to start one).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Design system tokens");
        await tool(page, "Show processes");
        await need(page, page.locator("[data-processes]"), "processes tab", 15000);
        if (await page.locator("[data-processes] [data-row]").filter({ visible: true }).count()) throw new Error("not reached: the empty state (the project lists processes)");
        await page.waitForTimeout(600);
      },
    },
  ],

  review: [
    {
      name: "picker-skeleton",
      text: "Review tab just opened: the pull request list while it loads (time held so the skeleton stays).",
      sizes: "one",
      busy: true,
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await page.clock.install();
        await page.clock.pauseAt(new Date(Date.now() + 1000));
        await page
          .getByRole("button", { name: /^Review/ })
          .filter({ visible: true })
          .first()
          .click();
        await page.waitForTimeout(600);
        const skeleton = await page.locator("[aria-hidden] span.h-2.rounded-full.bg-hover").filter({ visible: true }).count();
        if (skeleton === 0) throw new Error("no skeleton showed while loading");
      },
    },
    {
      name: "picker",
      text: "Review tab: the list of open pull requests with their checks.",
      sizes: "all",
      run: async (page, env) => {
        await reviewPicker(page, env);
        await need(page, page.getByText("Retry transient 5xx"), "pull request list", 15000);
      },
    },
    {
      name: "filter-tabs",
      text: "The picker filtered to 'Review requested'.",
      sizes: "one",
      run: async (page, env) => {
        await reviewPicker(page, env);
        await need(page, page.getByText("Retry transient 5xx"), "pull request list", 15000);
        await clickText(page, /^Review requested/);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "gh-not-logged-in",
      text: "?review=notloggedin: the code host says gh is not logged in (with the command to run).",
      sizes: "one",
      run: async (page, env) => {
        await reviewPicker(page, env, "demo=1&review=notloggedin");
        await need(page, page.getByText(/gh auth login|not logged in/i), "not logged in", 15000);
      },
    },
    {
      name: "review-open-with-threads",
      text: "Pull request #482 open: file list, diff and inline review threads.",
      sizes: "all",
      run: async (page, env) => {
        await reviewOpen(page, env);
      },
    },
    {
      name: "outdated-threads-strip",
      text: "The '1 thread not at a line' strip expanded above the diff.",
      sizes: "one",
      run: async (page, env) => {
        await reviewOpen(page, env);
        // The demo's thread that sits at no line belongs to retry.ts (the strip is per file).
        await page.getByText("retry.ts", { exact: true }).first().click();
        await page.waitForTimeout(900);
        await clickText(page, /outdated threads?|threads? not at a line/);
        await page.waitForTimeout(500);
      },
    },
    {
      name: "reply-being-written",
      text: "A thread's Reply opened with text typed in the box.",
      sizes: "one",
      run: async (page, env) => {
        await reviewOpen(page, env);
        await page.waitForTimeout(2000); // the inline threads are placed after the diff is drawn
        await page
          .locator("button:visible", { hasText: /^Reply$/ })
          .first()
          .waitFor({ state: "attached", timeout: 15000 });
        await page
          .locator("button:visible", { hasText: /^Reply$/ })
          .first()
          .evaluate((e) => {
            e.scrollIntoView({ block: "center" });
            e.click();
          });
        await page.waitForTimeout(500);
        // The reply box takes the focus when it opens.
        await need(page, page.getByLabel("Your reply"), "the reply box");
        await page.keyboard.insertText("Good catch. 429 is retried with the Retry-After value; I added a test for it.");
        await page.waitForTimeout(400);
      },
    },
    {
      name: "run-panel-running",
      text: "The review's command panel while 'Tests' is still running (output so far).",
      sizes: "one",
      run: async (page, env) => {
        await reviewOpen(page, env);
        await page.getByRole("button", { name: "Tests", exact: true }).filter({ visible: true }).first().click();
        await page.waitForTimeout(1100);
      },
    },
    {
      name: "run-panel-failed",
      text: "The command panel after 'Typecheck' failed (exit 2 with its errors).",
      sizes: "one",
      run: async (page, env) => {
        await reviewOpen(page, env);
        await page.getByRole("button", { name: "Typecheck", exact: true }).filter({ visible: true }).first().click();
        await page.waitForTimeout(2800);
      },
    },
    {
      name: "check-out-dialog-dirty",
      text: "'Check out' with uncommitted changes in the working copy: the dialog lists the dirty files.",
      sizes: "one",
      run: async (page, env) => {
        await reviewOpen(page, env);
        await page
          .getByRole("button", { name: /^Check out/ })
          .filter({ visible: true })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /Check out in my folder/ }).click();
        await page.waitForTimeout(800);
        const again = page.getByRole("dialog");
        await need(page, again, "check-out dialog");
        await need(page, again.getByText(/uncommitted|changes/i), "dirty files list");
      },
    },
    {
      name: "checked-out-line",
      text: "After checking the branch out: the header's 'checked out' line.",
      sizes: "one",
      run: async (page, env) => {
        await reviewOpen(page, env);
        await page
          .getByRole("button", { name: /^Check out/ })
          .filter({ visible: true })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /Check out in my folder/ }).click();
        await page.waitForTimeout(800);
        const dlg = page.getByRole("dialog");
        if (await dlg.isVisible().catch(() => false)) {
          await dlg.getByRole("button", { name: /^Check out and keep/ }).click();
          await page.waitForTimeout(1500);
        }
        await need(page, page.getByText(/switched to|already on/i), "checked-out line", 8000);
      },
    },
    {
      name: "submit-sheet",
      text: "'Submit review': the sheet with the verdict, summary and the comments that will be posted.",
      sizes: "all",
      run: async (page, env) => {
        await reviewOpen(page, env);
        await page
          .getByRole("button", { name: "Submit review" })
          .first()
          .evaluate((e) => e.click());
        await need(page, page.getByRole("dialog"), "submit sheet");
        await page.waitForTimeout(1200);
      },
    },
  ],

  settings: [
    ...[
      ["general", "General", "On startup"],
      ["appearance", "Appearance", "Theme"],
      ["providers", "Providers", "Claude Code"],
      ["models", "Models", "Models"],
      ["editor", "Editor", "Editor"],
      ["usage", "Usage and budget", "budget"],
      ["memory", "Memory", "Memory"],
      ["privacy", "Privacy and data", "Privacy"],
      ["commands", "Commands and review", "Commands"],
      ["about", "About", "About"],
    ].map(([id, label, text]) => ({
      name: id === "providers" ? "providers-with-roles-pane" : id,
      text: `Settings page, section "${label}".${id === "providers" ? " The first ready agent is selected, so its preferred model and roles show on the right." : ""}`,
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=1", `#/settings/${id}`);
        await need(page, page.getByText(new RegExp(text, "i")), `settings section ${label}`, 12000);
        await page.waitForTimeout(1000);
      },
    })),
    {
      name: "project-settings-dialog",
      text: "Atlas API: the project settings dialog (name, instructions, folders, models, budget).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await projectSettings(page);
      },
    },
    {
      name: "always-allowed-rules",
      text: "Docs site: the project settings dialog scrolled to 'Always-allowed requests' after a rule was saved from an approval.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "approvals demo please");
        await need(page, page.locator("[data-v7-approval-group], [data-v7-approval]").first(), "approvals");
        await page.waitForTimeout(500);
        await page
          .getByRole("button", { name: /^Always allow/ })
          .last()
          .click();
        await need(page, page.locator("[data-always-panel]"), "rule panel");
        await click(page, /Save rule and allow/);
        await page.waitForTimeout(1500);
        await projectSettings(page);
        const h = page.getByText("Always-allowed requests").first();
        await need(page, h, "rules list");
        await h.click();
        await page.waitForTimeout(700);
        await h.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
      },
    },
  ],

  shell: [
    {
      name: "command-palette-empty",
      text: "Docs site: the command palette just opened, no query (suggested actions).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await palette(page, "", false);
      },
    },
    {
      name: "command-palette-results",
      text: "The palette with the query 'set': matching actions and projects.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await palette(page, "set", false);
      },
    },
    {
      name: "command-palette-past-requests",
      text: "The palette with 'slowest': the one 'Requests' group (this project's first, then older hits of the harness's search).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await palette(page, "slowest", false);
        await page.waitForTimeout(900);
        await need(page, page.getByText("Requests", { exact: true }), "requests group");
      },
    },
    {
      name: "sidebar-closed",
      text: "Docs site with the sidebar hidden (the conversation uses the width).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        const hide = page.getByRole("button", { name: "Hide sidebar" }).filter({ visible: true }).first();
        if (await hide.isVisible().catch(() => false)) {
          await hide.click();
          await page.waitForTimeout(600);
        }
      },
    },
    {
      name: "status-bar-close-up",
      text: "Close-up of the status bar (bottom 56 px of the window) on a project with a budget and a running turn.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "live activity please");
        await page.waitForTimeout(1500);
        env.clip = { x: 0, y: env.height - 56, width: env.width, height: 56 };
      },
    },
    {
      name: "project-actions-menu",
      text: "The project's '\u22ef' menu in the tab strip (agents, details, usage, side question, export, settings).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await click(page, /^Project actions$/);
        await need(page, page.getByRole("menu"), "project actions menu");
      },
    },
    {
      name: "tab-strip-many-tabs",
      text: "Atlas API with the conversation, six tools and two files open: the tab strip with many tabs.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        for (const t of ["Show agents", "Show notes", "Show memory", "Show changes", "Show usage", "Show files"]) await tool(page, t);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "offline-bridge",
      text: "No demo and no harness listening: the offline state with its next step.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "");
        await need(page, page.getByText(/offline|isn.t running|can.t reach|not running/i), "offline state", 15000);
      },
    },
  ],
  /* ---------- batches 1-3 ---------- */

  "review-b3": [
    {
      name: "picker-repository-menu",
      text: "Review picker of Atlas API (a fork and its parent): the Repository menu open, the tracked parent checked.",
      sizes: "all",
      run: async (page, env) => {
        await reviewPicker(page, env);
        await need(page, page.getByText("Retry transient 5xx"), "pull request list", 15000);
        await click(page, /^Repository/);
        await need(page, page.getByRole("menu"), "repository menu");
      },
    },
    {
      name: "picker-refusal",
      text: "Review picker: a pull request number that exists in both repositories is refused, with one button per repository.",
      sizes: "all",
      run: async (page, env) => {
        await reviewPicker(page, env);
        const field = page
          .getByRole("searchbox")
          .or(page.getByLabel(/Search pull requests/))
          .first();
        await field.fill("482");
        await field.press("Enter");
        await need(page, page.getByText(/Which repository is it in|Pick the repository/), "the refusal", 12000);
      },
    },
    {
      name: "local-branches",
      text: "Review picker, Local branches: the folder's branches to review without a pull request.",
      sizes: "all",
      run: async (page, env) => {
        await reviewPicker(page, env);
        await need(page, page.getByText("Retry transient 5xx"), "pull request list", 15000);
        await page.getByRole("tab", { name: "Local branches" }).click();
        await page.waitForTimeout(1200);
        await need(page, page.getByRole("tab", { name: "Local branches", selected: true }), "branches view");
      },
    },
    {
      name: "review-maximised",
      text: "Pull request #482 open: its group is maximised (the diff has the whole window; the sidebar and the conversation step aside).",
      sizes: "all",
      run: async (page, env) => {
        // Opening a review maximises its group (the sidebar and the conversation step aside; Esc restores).
        await reviewOpen(page, env);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "run-tab",
      text: "A project command's own tab after 'Tests' ran from the tab strip.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        const pinned = page.getByRole("button", { name: "Tests", exact: true }).filter({ visible: true }).first();
        if (await pinned.isVisible().catch(() => false)) await pinned.click();
        else {
          // Narrow: the pinned buttons fold into the Run menu.
          await page
            .getByRole("button", { name: /Run a project command/ })
            .filter({ visible: true })
            .first()
            .click();
          await page.getByRole("menuitem", { name: /Tests/ }).click();
        }
        await need(page, page.getByRole("tab", { name: /Tests/ }), "the run tab", 10000);
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "tab-strip-pinned-commands",
      text: "Atlas API: the tab strip with the pinned project commands (Tests, Typecheck) and the Run menu.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await need(page, page.getByRole("button", { name: "Tests", exact: true }), "pinned command");
        await need(page, page.getByRole("button", { name: /Run a project command/ }), "Run menu");
      },
    },
  ],

  providers: [
    {
      name: "owner-list",
      text: "Settings, Providers with ?providers=owner (the twelve): the list in its groups, the first ready agent selected.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=1&providers=owner", "#/settings/providers");
        await need(page, page.getByText("Claude Code").first(), "providers list", 12000);
        await page.waitForTimeout(900);
      },
    },
    ...[
      ["api-not-connected", "Anthropic API", "The API row (no key): its detail asks for the key."],
      ["agent-many-models", "OpenCode", "A ready agent with twelve models: its detail with the model list."],
      ["agent-experimental", "Antigravity", "A ready experimental agent: its detail with the experimental mark."],
      ["agent-not-installed", "Cursor", "An agent that is not installed: its detail with the install hint."],
    ].map(([name, label, text]) => ({
      name,
      text: `Settings, Providers (?providers=owner): ${text}`,
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=1&providers=owner", "#/settings/providers");
        const more = page.getByRole("button", { name: /more providers? can be added/ });
        await more.waitFor({ timeout: 12000 });
        const row = page.getByRole("group", { name: "Providers" }).getByText(label, { exact: true }).first();
        if (!(await row.isVisible().catch(() => false))) await more.click();
        await row.waitFor({ timeout: 8000 });
        await row.click();
        await page.waitForTimeout(900);
      },
    })),
    {
      name: "agent-not-logged-in",
      text: "Settings, Providers (default demo): Copilot is not logged in; its detail with the login hint and Check again.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=1", "#/settings/providers");
        const row = page.getByRole("group", { name: "Providers" }).getByText("Copilot", { exact: false }).first();
        await row.waitFor({ timeout: 12000 });
        await row.click();
        await need(page, page.getByText(/not logged in|Check again/i), "login state");
        await page.waitForTimeout(700);
      },
    },
    {
      name: "model-refused-notice",
      text: "Atlas API: picking the not-logged-in Copilot as the model is refused; the notice above the composer offers Check again and Use anyway.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await page
          .getByRole("button", { name: /^Model/ })
          .filter({ visible: true })
          .first()
          .click();
        const row = page
          .getByText(/Copilot/)
          .filter({ visible: true })
          .first();
        await row.waitFor({ timeout: 8000 });
        await row.click();
        await need(page, page.getByRole("button", { name: "Use anyway" }), "the refused-model notice", 10000);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      },
    },
  ],

  "settings-b3": [
    {
      name: "commands-add-dialog",
      text: "Settings, Commands and review: the dialog that adds a project command.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=1", "#/settings/commands");
        await need(page, page.getByText(/Commands/i), "section", 12000);
        await page
          .getByRole("button", { name: /Add a command|Add command|^Add/ })
          .filter({ visible: true })
          .first()
          .click();
        await need(page, page.getByRole("dialog"), "add-command dialog");
      },
    },
    {
      name: "commands-offered-choose",
      text: "Settings, Commands and review: 'Commands offered' in a review: the dialog that chooses which commands a pull request's Run menu lists.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=1", "#/settings/commands");
        await page.getByRole("button", { name: "Choose" }).filter({ visible: true }).first().click({ timeout: 12000 });
        await need(page, page.getByRole("dialog"), "commands offered dialog");
      },
    },
  ],

  memory: [
    {
      name: "sessions-list",
      text: "Atlas API, Memory tab, Sessions: the list of sessions with the first one open on the right.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await need(page, page.getByRole("tab", { name: "Sessions" }), "Sessions view", 10000);
        await page.getByRole("tab", { name: "Sessions" }).click();
        await need(page, page.locator("[aria-label='Sessions']").first(), "sessions list", 10000);
      },
    },
    {
      name: "session-open",
      text: "Memory, Sessions: one session open, its requests and answers word for word.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Sessions" }).click();
        const list = page.locator("[aria-label='Sessions']").first();
        await list.waitFor({ timeout: 10000 });
        await list.locator("button[data-row]").first().click();
        await need(page, page.locator("[aria-label='Requests'], [aria-label='Exchanges']").first(), "exchanges", 10000);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "forget-confirm",
      text: "Memory, Sessions: 'Forget this exchange' asks to confirm before the exchange is deleted.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Sessions" }).click();
        const list = page.locator("[aria-label='Sessions']").first();
        await list.waitFor({ timeout: 10000 });
        await list.locator("button[data-row]").first().click();
        await page
          .getByRole("button", { name: /^(Request|Exchange) actions$/ })
          .filter({ visible: true })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /Forget this (exchange|request)/ }).click();
        await need(
          page,
          page.getByRole("dialog", { name: /Forget this (exchange|request)/ }).or(page.getByText(/Forget this (exchange|request)\?/)),
          "forget confirmation",
        );
      },
    },
  ],

  sessions: [
    {
      name: "list",
      text: "Atlas API, Sessions tab: the project's sessions as one list (the main sessions, their agents under the open one) with the filters.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show sessions");
        await need(page, page.locator("[aria-label='Sessions']").first(), "sessions list", 10000);
        await page.waitForTimeout(500);
      },
    },
    {
      name: "main-detail",
      text: "Sessions: a main session open on the right: header with its actions, the conversation word for word, the footer.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show sessions");
        const list = page.locator("[aria-label='Sessions']").first();
        await list.waitFor({ timeout: 10000 });
        await page.waitForTimeout(800);
        await list.locator("button[data-row]").first().click();
        await page
          .locator("article")
          .first()
          .waitFor({ state: "attached", timeout: 15000 })
          .catch(() => {
            throw new Error("not reached: the session's conversation");
          });
        await page.waitForTimeout(400);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "agent-detail",
      text: "Sessions, filter Agents: an agent session open: its task, who started it and its usage, the conversation, the message box.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show sessions");
        const list = page.locator("[aria-label='Sessions']").first();
        await list.waitFor({ timeout: 10000 });
        await page
          .getByRole("radio", { name: /^Agents/ })
          .filter({ visible: true })
          .first()
          .click({ timeout: 8000 });
        await page.waitForTimeout(800);
        await list.locator("button[data-row]").first().click();
        await page
          .locator("[data-activity-row], article")
          .first()
          .waitFor({ state: "attached", timeout: 15000 })
          .catch(() => {
            throw new Error("not reached: the agent session's conversation");
          });
        await page.waitForTimeout(400);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "sidebar-expanded",
      text: "The sidebar's tree (decision 96): a project open to its sessions (its five latest and any at work, then 'Show all (N)').",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await need(page, page.getByRole("tree").getByRole("group").first(), "sessions under an open project");
        await page.waitForTimeout(400);
      },
    },
    {
      name: "conversation-tab",
      text: "Atlas API: a project session opened from the sidebar tree as its own conversation tab (Plan the release).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await page
          .getByRole("treeitem", { name: /Plan the release/ })
          .filter({ visible: true })
          .first()
          .click({ timeout: 8000 });
        await need(page, page.getByText(/Three things block Friday/), "the session's conversation", 15000);
        await need(page, page.locator('[role="tab"][data-tab-id^="session:"]'), "a session tab in the strip");
        await page.waitForTimeout(600);
      },
    },
  ],

  notes: [
    {
      name: "list",
      text: "Atlas API, Notes: the list of notes with their descriptions and the search field.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show notes");
        await need(page, page.locator("[aria-label='Notes']").first(), "note list", 10000);
      },
    },
    {
      name: "detail",
      text: "Notes: one note open on the right (title, description, text).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show notes");
        const list = page.locator("[aria-label='Notes']").first();
        await list.waitFor({ timeout: 10000 });
        await list.locator("[data-row]").first().click();
        await page.waitForTimeout(1000);
      },
    },
    {
      name: "editor",
      text: "Notes: the note in its editor.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show notes");
        const list = page.locator("[aria-label='Notes']").first();
        await list.waitFor({ timeout: 10000 });
        await list.locator("[data-row]").first().click();
        await page.getByRole("button", { name: /^Edit/ }).filter({ visible: true }).first().click();
        await page.waitForTimeout(1200);
      },
    },
  ],

  usage: [
    ...[
      ["by-model", "Atlas API, Usage, By model (the default): input, cached, output, total, requests and cost per model."],
      ["by-agent", "Usage, By agent."],
      ["by-day", "Usage, By day."],
    ].map(([name, text]) => ({
      name,
      text,
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show usage");
        const label = { "by-model": "By model", "by-agent": "By agent", "by-day": "By day" }[name];
        await page.getByRole("tab", { name: label }).click({ timeout: 10000 });
        await page.waitForTimeout(1200);
      },
    })),
    {
      name: "by-model-roles",
      text: "Usage, By model with 'Show roles' on (the agents' roles joined to their models).",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show usage");
        await page.getByRole("tab", { name: "By model" }).click({ timeout: 10000 });
        await page
          .getByRole("button", { name: /Show (roles|tiers)/ })
          .filter({ visible: true })
          .first()
          .click();
        await page.waitForTimeout(1200);
      },
    },
    {
      name: "settings-by-project",
      text: "Settings, Usage and budget: usage by project, one row opened to its models.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env, "demo=1", "#/settings/usage");
        await need(page, page.getByText(/Usage by project/i), "table", 12000);
        const row = page
          .getByRole("button", { name: /Atlas API/ })
          .filter({ visible: true })
          .first();
        await row.click();
        await page.waitForTimeout(1200);
      },
    },
  ],

  gallery: ["buttons", "fields", "rows", "surfaces", "scales"].map((id) => ({
    name: id,
    text: `Component library gallery (?gallery=1), section "${id}".`,
    sizes: "one",
    run: async (page, env) => {
      await boot(page, env, "demo=1&gallery=1");
      const section = page.locator(`[data-gallery-section="${id}"]`);
      await need(page, section, `gallery section ${id}`, 12000);
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const box = await section.boundingBox();
      if (box) {
        // The whole section, even when it is taller than the window: a full-page capture clipped in document coordinates.
        const top = await page.evaluate(() => window.scrollY);
        env.fullPage = true;
        env.clip = { x: 0, y: Math.max(0, top + box.y - 8), width: env.width, height: box.height + 16 };
      }
    },
  })),

  polish: [
    {
      name: "approvals-grouped",
      text: "Docs site, 'approvals demo please': several pending approvals as one group of cards (decision 91c), one Allow / Deny each.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Docs site");
        await send(page, "approvals demo please");
        await need(page, page.locator("[data-v7-approval-group], [data-v7-approval]"), "approval group");
        await page.waitForTimeout(500);
        await page.locator("[data-v7-approval-group], [data-v7-approval]").first().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "activity-rows",
      text: "Atlas API, a request running: thinking, tool and delegation steps as one activity row each (glyph, verb, detail, time).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await need(page, page.locator("[data-activity-row]"), "activity rows", 20000);
        await page.locator("[data-activity-row]").last().scrollIntoViewIfNeeded();
      },
    },
    {
      name: "composer-row",
      text: "Atlas API: the composer's one row (attach, mode, model chip with its routing, context ring, send).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await need(page, page.locator("[data-composer-wrap]"), "composer");
        await composer(page).fill("Summarise the failing tests");
      },
    },
    {
      name: "slash-menu",
      text: "Atlas API: '/' in the composer opens the command menu (Octo commands first, the agent's below).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await composer(page).click();
        await composer(page).fill("/");
        await need(page, page.getByRole("listbox").first(), "slash menu");
      },
    },
    {
      name: "slash-context-report",
      text: "Atlas API: '/context' opens the window report sheet (stacked bar with colour keys, categories, not loaded, largest messages).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await composer(page).click();
        await composer(page).fill("/context");
        await page.keyboard.press("Enter");
        await need(page, page.getByRole("dialog", { name: /^Context( window)?$/ }), "window report");
        await page.waitForTimeout(800);
      },
    },
    {
      name: "window-report-from-ring",
      text: "Atlas API: the context ring's popover, then 'Open context details': the same window report.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await page
          .getByRole("button", { name: /^Context:/ })
          .first()
          .click();
        await need(page, page.getByRole("button", { name: "Open context details" }), "popover button");
        await page.getByRole("button", { name: "Open context details" }).click();
        await need(page, page.getByRole("dialog", { name: /^Context( window)?$/ }), "window report");
        await page.waitForTimeout(800);
      },
    },
    {
      name: "images-attached",
      text: "Atlas API: an image attached to the next message (chip with thumbnail, remove).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQYV2P8z8Dwn4EIwDiqkL4KAQBM0Af9eQ4h3AAAAABJRU5ErkJggg==", "base64");
        await page.locator("input[type=file]").first().setInputFiles({ name: "screenshot.png", mimeType: "image/png", buffer: png });
        await need(page, page.locator("[data-image-chip]"), "image chip", 10000);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "error-notice-structured",
      text: "Changelog bot: a failed start as the harness words it (message, hint, 'Check again'); Details folded.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Changelog bot");
        await need(page, page.locator("[data-turn-outcome='failed']"), "failed banner");
      },
    },
    {
      name: "tree-column-page-mode",
      text: "Atlas API at the window's own width: the file tree as a column beside the editor (wide) or as a page (narrow).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openPath(page, ["src", "auth", "refresh.ts"]);
        await editorReady(page);
      },
    },
    {
      name: "tree-column-hidden",
      text: "Atlas API: the tree column hidden with the editor-bar toggle; the editor has the whole group.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openPath(page, ["src", "auth", "refresh.ts"]);
        await editorReady(page);
        await page
          .getByRole("button", { name: /file tree|Hide files|Show files/i })
          .filter({ visible: true })
          .first()
          .click();
        await page.waitForTimeout(500);
      },
    },
    {
      name: "memory-sessions",
      text: "Memory, view 1 of 3: Sessions.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Sessions" }).click();
        await need(page, page.locator("[aria-label='Sessions']").first(), "sessions list", 10000);
      },
    },
    {
      name: "memory-knowledge",
      text: "Memory, view 2 of 3: Knowledge.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Knowledge" }).click();
        await page.waitForTimeout(900);
      },
    },
    {
      name: "memory-files",
      text: "Memory, view 3 of 3: Files.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await tool(page, "Show memory");
        await page.getByRole("tab", { name: "Files" }).click();
        await page.waitForTimeout(900);
      },
    },
    {
      name: "home-rows",
      text: "Home: projects as list rows on the shared scale, failures as one plain line.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await home(page);
        await page.waitForTimeout(600);
      },
    },
    {
      name: "connect-providers-list",
      text: "No provider connected: the connect screen is the providers list; a row opens its detail.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=1&providers=none");
        await home(page);
        await need(page, page.getByRole("group", { name: "Providers" }), "providers list");
        await page.getByRole("group", { name: "Providers" }).locator("[data-row]").first().click();
        await page.waitForTimeout(700);
      },
    },
  ],
  /* ---------- states built in the week of 2026-11-10 (backlog) ---------- */
  "week-states": [
    {
      name: "shortcuts-sheet",
      text: "Atlas API: the keyboard shortcuts sheet (palette → Keyboard shortcuts, or ?).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        // The palette offers it on a desktop width only (the phone has no keyboard shortcuts).
        if (env.width < 768) throw new Error("not on a phone: the palette lists Keyboard shortcuts on a desktop width only");
        await palette(page, "Keyboard shortcuts");
        await need(page, page.getByRole("dialog"), "shortcuts sheet");
        await page.waitForTimeout(500);
      },
    },
    {
      name: "settings-integrations",
      text: "Settings → Integrations: the plugins, their language servers, agents and tool servers.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=1", "#/settings/integrations");
        await need(page, page.locator("[data-settings]"), "settings page");
        await page.waitForTimeout(900);
      },
    },
    {
      name: "image-preview",
      text: "Files: atlas-web/public/logo.png previewed (pixel and file size, Fit | 100 %).",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openTreePath(page, "atlas-web/public/logo.png");
        await need(page, page.locator("[data-image-preview] img"), "image preview");
      },
    },
    {
      name: "image-preview-svg",
      text: "Files: an SVG shown as a picture, with the Preview | Source switch.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        await openTreePath(page, "atlas-web/public/mark.svg");
        await need(page, page.locator("[data-image-preview] img"), "SVG preview");
      },
    },
    {
      name: "tool-showcase-expanded",
      text: "Atlas API, its first request: every kind of tool call, each row opened.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        const turn = page.locator("[data-turn-key]").first();
        await turn.scrollIntoViewIfNeeded();
        const rows = turn.locator('[data-activity-row] [aria-expanded="false"]:not([aria-haspopup])');
        for (let i = 0; i < 12 && (await rows.count()); i++) {
          await rows.first().click({ timeout: 4000 });
          await page.waitForTimeout(200);
        }
        await need(page, page.locator("[data-tool-body]"), "an opened tool call");
        await page.keyboard.press("Escape");
        await turn.scrollIntoViewIfNeeded();
      },
    },
    {
      name: "turn-changes-expanded",
      text: "Atlas API: a turn's changed-files line opened to its rows and a diff.",
      sizes: "one",
      run: async (page, env) => {
        await boot(page, env);
        await project(page, env, "Atlas API");
        const line = page.locator("[data-turn-changes]").first();
        await line.scrollIntoViewIfNeeded();
        await line.getByRole("button").nth(1).click({ timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },
    {
      name: "project-gone",
      text: "A project address that no longer exists (deleted in another window): the place says so, with the way Home.",
      sizes: "all",
      run: async (page, env) => {
        await boot(page, env, "demo=1", "#/p/prj_gone");
        await need(page, page.getByText(/no longer exists/), "project-gone state", 10000);
      },
    },
  ],
};
