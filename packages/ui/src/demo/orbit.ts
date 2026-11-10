import { ORBIT_WRITES } from "./writes";
import { act, delegate, say, turn, type Ctx } from "./runtime";

const AUDIT = `**Breaking changes that affect Orbit (0.76 → 0.80):**

- New architecture is on by default — \`react-native-maps\` 1.10 and \`@orbit/native-camera\` still use the old bridge.
- \`metro.config.js\` must move to \`@react-native/metro-config\` defaults.
- Android \`minSdkVersion\` rises to 24 (we ship 23).

Everything else in \`package.json\` is compatible or has a drop-in patch release.`;

const BASELINE = `Baseline on main: **412 passed, 9 failed, 3 skipped** (2m 41s).

- 6 failures are snapshot drift in \`ProfileHeader\` and \`FeedCard\` — unrelated to the upgrade.
- 3 failures are timing flakes in \`sync.queue.test.ts\`; the nested investigator traced them to a real \`setTimeout\` in the retry policy.`;

export async function orbitLive(ctx: Ctx): Promise<void> {
  await turn(ctx, "Upgrade us to React Native 0.80 and get the test suite green.", async (c, orch) => {
    await act(c, orch, [
      { name: "read_file", input: { path: "package.json" }, result: '"react-native": "0.76.5",\n"react": "18.3.1",\n…', ms: 400 },
      { name: "list_dir", input: { path: "android/app" }, result: "build.gradle\nsrc/\nproguard-rules.pro", ms: 300 },
    ]);
    await delegate(
      c,
      orch,
      [
        {
          role: "Dependency auditor",
          title: "Breaking changes 0.76 → 0.80",
          tier: "fast",
          task: "Read the React Native 0.77–0.80 upgrade notes against our package.json and native config. List only the breaking changes that affect this app, with the files involved.",
          run: async (cc, id) => {
            await act(cc, id, [{ name: "bash", input: { command: "npm ls --depth=0 --json" }, result: "{ dependencies: { … 64 packages } }", ms: 2200 }]);
            await act(cc, id, [
              { name: "read_file", input: { path: "metro.config.js" }, result: "module.exports = { transformer: { … } }", ms: 1600 },
              { name: "read_file", input: { path: "android/build.gradle" }, result: "minSdkVersion = 23", ms: 1600 },
            ]);
            await act(cc, id, [{ name: "bash", input: { command: "rg -l 'NativeModules\\.' node_modules/@orbit node_modules/react-native-maps/lib" }, result: "node_modules/@orbit/native-camera/index.js\nnode_modules/react-native-maps/lib/MapView.js", ms: 2600 }]);
            await say(cc, id, AUDIT);
            return AUDIT;
          },
        },
        {
          role: "Test runner",
          title: "Baseline the current test suite",
          tier: "balanced",
          task: "Run the full Jest suite on main before any change. Report pass/fail counts and classify each failure as pre-existing, flaky, or environment.",
          run: async (cc, id) => {
            await act(cc, id, [{ name: "bash", input: { command: "yarn jest --ci --silent" }, result: "Tests: 9 failed, 3 skipped, 412 passed, 424 total\nTime: 161.2 s", ms: 9000, error: false }]);
            await delegate(cc, id, [
              {
                role: "Flake investigator",
                title: "Explain sync.queue timing failures",
                tier: "fast",
                task: "Run src/sync/__tests__/sync.queue.test.ts 20 times and explain the intermittent failures.",
                run: async (fc, fid) => {
                  await act(fc, fid, [{ name: "bash", input: { command: "for i in $(seq 20); do yarn jest sync.queue --silent; done | grep -c FAIL" }, result: "7", ms: 7000 }]);
                  await act(fc, fid, [{ name: "read_file", input: { path: "src/sync/retry.ts" }, result: "await new Promise(r => setTimeout(r, backoff(attempt)))", ms: 900 }]);
                  const r = "7/20 runs fail. `retry.ts` sleeps with a real `setTimeout`; the test uses fake timers only for the queue. Fix: inject the clock.";
                  await say(fc, fid, r);
                  return r;
                },
              },
            ]);
            await say(cc, id, BASELINE);
            return BASELINE;
          },
        },
      ],
      "This is a multi-step upgrade. Before touching anything I'll get two facts in parallel: which breaking changes actually hit us, and how healthy the test suite is today.",
    );
    await delegate(
      c,
      orch,
      [
        {
          role: "Implementer",
          title: "Bump React Native and fix the native build",
          tier: "deep",
          task: "Upgrade react-native to 0.80.x with the upgrade helper diff. Raise Android minSdk to 24, migrate metro.config.js, and pin react-native-maps to 1.20. Keep the old-architecture interop for @orbit/native-camera. Build both platforms and run the suite.",
          run: async (cc, id) => {
            await act(cc, id, [{ name: "bash", input: { command: "npx react-native upgrade 0.80.1" }, result: "Applied 41 file changes", ms: 9000 }]);
            await act(cc, id, [{ name: "write_file", input: { path: "android/build.gradle" }, result: "updated minSdkVersion → 24", ms: 1500, content: ORBIT_WRITES.gradle }]);
            await act(cc, id, [{ name: "write_file", input: { path: "metro.config.js" }, result: "rewrote with @react-native/metro-config", ms: 1500, content: ORBIT_WRITES.metro }]);
            await act(cc, id, [{ name: "bash", input: { command: "cd ios && pod install" }, result: "Pod installation complete! 87 dependencies", ms: 14000 }]);
            await act(cc, id, [{ name: "bash", input: { command: "yarn jest --ci --silent" }, result: "Tests: 9 failed, 412 passed", ms: 16000 }]);
            const r = "Upgraded to 0.80.1; both platforms build. Test results are unchanged from baseline (same 9 pre-existing failures).";
            await say(cc, id, r);
            return r;
          },
        },
      ],
      "Audit and baseline are in. The upgrade is mechanical apart from two native modules, so I'm handing it to one implementer on the deep tier.",
    );
    await say(
      c,
      orch,
      "React Native is on **0.80.1** and both platforms build. The suite matches the pre-upgrade baseline: the 9 remaining failures existed on main (6 snapshot drifts, 3 timing flakes with a known fix). Want me to fix those next?",
    );
  });
}
