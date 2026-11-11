import { useEffect, useRef } from "react";
import { parseColor, renderStreak, streakCell } from "../../lib/streak";
import type { StreakPreset } from "../../lib/streakPresets";

/** How far the optional drift moves the band (CSS px); the canvas overhangs by this much on every side. */
const DRIFT = 12;

/**
 * The dithered light streak (decision 21b), drawn by `lib/streak.ts` on a canvas at cell resolution (3 CSS px,
 * 4 from 1920 wide) and scaled up with `pixelated` (so DPR does not change the cost), once per size / theme
 * change. The optional drift is a CSS transform (styles.css, `.octo-streak`). Loaded with `import()` on
 * the start screens only; `aria-hidden`, no pointer events. `data-draw-ms` records the last draw time.
 */
export default function Streak({ preset, theme }: { preset: StreakPreset; theme: "dark" | "light" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { anchor, rise, echo } = preset;
  const { x: anchorX, y: anchorY } = anchor;

  useEffect(() => {
    const el = canvas.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      const t0 = performance.now();
      const cell = streakCell(w);
      const cols = Math.ceil((w + 2 * DRIFT) / cell);
      const rows = Math.ceil((h + 2 * DRIFT) / cell);
      if (el.width !== cols || el.height !== rows) {
        el.width = cols;
        el.height = rows;
      }
      el.style.width = `${cols * cell}px`;
      el.style.height = `${rows * cell}px`;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const css = getComputedStyle(host);
      const img = ctx.createImageData(cols, rows);
      const t1 = performance.now();
      const peak = renderStreak(new Uint32Array(img.data.buffer), {
        cols,
        rows,
        cell,
        overhang: DRIFT,
        anchor: { x: anchorX, y: anchorY },
        rise,
        echo,
        panel: parseColor(css.getPropertyValue("--octo-panel")),
        accent: parseColor(css.getPropertyValue("--octo-accent")),
        theme,
      });
      const t2 = performance.now();
      ctx.putImageData(img, 0, 0);
      el.dataset.drawMs = (performance.now() - t0).toFixed(2);
      // The pixel work alone (`lib/streak.ts`), without reading the theme's colours and the canvas upload.
      el.dataset.renderMs = (t2 - t1).toFixed(2);
      el.dataset.peak = peak.toFixed(3);
      el.dataset.drawn = "";
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    // The drift runs only while the page is visible (and never under reduced motion: styles.css).
    const onVisibility = () => {
      if (document.hidden) el.dataset.paused = "";
      else delete el.dataset.paused;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [anchorX, anchorY, rise, echo, theme]);

  return <canvas ref={canvas} aria-hidden data-streak className="octo-streak" />;
}
