import { useEffect, useRef } from "react";
import { parseColor, renderStreak, type StreakAnchor } from "../../lib/streak";

/** Cell size of the ordered dither, in CSS px (decision 21: visible but fine grain). */
const CELL = 2;
/** How far the optional drift moves the band (CSS px); the canvas overhangs by this much on every side. */
const DRIFT = 12;

/**
 * The dithered light streak (contract v6 decision 21), drawn by `lib/streak.ts` on a canvas at cell
 * resolution and scaled up with `pixelated` (so DPR does not change the cost), once per size / theme
 * change. The optional drift is a CSS transform (styles.css, `.octo-streak`). Loaded with `import()` on
 * the start screens only; `aria-hidden`, no pointer events. `data-draw-ms` records the last draw time.
 */
export default function Streak({ anchor, theme }: { anchor: StreakAnchor; theme: "dark" | "light" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
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
      const cols = Math.ceil((w + 2 * DRIFT) / CELL);
      const rows = Math.ceil((h + 2 * DRIFT) / CELL);
      if (el.width !== cols || el.height !== rows) {
        el.width = cols;
        el.height = rows;
      }
      el.style.width = `${cols * CELL}px`;
      el.style.height = `${rows * CELL}px`;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const css = getComputedStyle(host);
      const img = ctx.createImageData(cols, rows);
      const peak = renderStreak(new Uint32Array(img.data.buffer), {
        cols,
        rows,
        cell: CELL,
        overhang: DRIFT,
        anchor: { x: anchorX, y: anchorY },
        panel: parseColor(css.getPropertyValue("--octo-panel")),
        accent: parseColor(css.getPropertyValue("--octo-accent")),
        indigo: parseColor(css.getPropertyValue("--octo-streak-indigo")),
        warm: parseColor(css.getPropertyValue("--octo-warn")),
        peak: theme === "dark" ? 0.55 : 0.22,
        rimPeak: theme === "dark" ? 0.3 : 0.14,
      });
      ctx.putImageData(img, 0, 0);
      el.dataset.drawMs = (performance.now() - t0).toFixed(2);
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
  }, [anchorX, anchorY, theme]);

  return <canvas ref={canvas} aria-hidden data-streak className="octo-streak" />;
}
