import { useEffect, useRef } from "react";
import { parseColor, renderStreak, streakCell } from "../../lib/streak";
import { STREAK_NARROW_BELOW, type StreakPreset } from "../../lib/streakPresets";

/** How far the optional drift moves the band (CSS px); the canvas overhangs by this much on every side. */
const DRIFT = 12;
/** A resize redraws once this long after the last size change; meanwhile the last frame stretches with the host. */
const RESIZE_SETTLE_MS = 120;

/**
 * The dithered light streak (decision 32), drawn by `lib/streak.ts` into the canvas's own bitmap at cell resolution
 * (2 CSS px up to a 1600px window, 3 above) and scaled up with `pixelated`, so DPR does not change the cost. It is
 * drawn once, and again only when the host's size settles after a resize or the theme changes — nothing runs per
 * frame while it is static (the optional drift is a compositor transform, styles.css). While a resize is in flight the
 * last frame stretches with the host (its CSS size is relative). `data-draws` counts draws, `data-draw-ms` /
 * `data-render-ms` time the last one. Loaded with `import()` on the start screens only; `aria-hidden`.
 */
export default function Streak({ preset, theme }: { preset: StreakPreset; theme: "dark" | "light" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { anchor, rise, echo, narrow } = preset;
  const { x: anchorX, y: anchorY } = anchor;
  const nX = narrow?.anchor.x ?? anchorX;
  const nY = narrow?.anchor.y ?? anchorY;
  const nRise = narrow?.rise ?? rise;

  useEffect(() => {
    const el = canvas.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    let frame = 0;
    let timer = 0;
    let drawn = "";
    const draw = () => {
      frame = 0;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const cell = streakCell(window.innerWidth);
      const key = `${w}x${h}@${cell}`;
      if (w === 0 || h === 0 || key === drawn) return;
      drawn = key;
      const t0 = performance.now();
      const cols = Math.ceil((w + 2 * DRIFT) / cell);
      const rows = Math.ceil((h + 2 * DRIFT) / cell);
      el.width = cols;
      el.height = rows;
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
        // A narrow (portrait) host takes the preset's narrow geometry, so the band keeps clear of the text there too.
        ...(w < STREAK_NARROW_BELOW ? { anchor: { x: nX, y: nY }, rise: nRise } : { anchor: { x: anchorX, y: anchorY }, rise }),
        echo,
        panel: parseColor(css.getPropertyValue("--octo-panel")),
        accent: parseColor(css.getPropertyValue("--octo-accent")),
        theme,
      });
      const t2 = performance.now();
      ctx.putImageData(img, 0, 0);
      // The bitmap covers cols × cell CSS px; as a share of the host it keeps stretching with it until the next draw.
      el.style.width = `${((cols * cell) / w) * 100}%`;
      el.style.height = `${((rows * cell) / h) * 100}%`;
      el.dataset.drawMs = (performance.now() - t0).toFixed(2);
      el.dataset.renderMs = (t2 - t1).toFixed(2);
      el.dataset.peak = peak.toFixed(3);
      el.dataset.draws = String(Number(el.dataset.draws ?? 0) + 1);
      el.dataset.drawn = "";
    };
    const now = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(now, drawn ? RESIZE_SETTLE_MS : 0);
    };
    now();
    const ro = new ResizeObserver(settle);
    ro.observe(host);
    // The drift runs only while the page is visible (and never under reduced motion: styles.css).
    const onVisibility = () => {
      if (document.hidden) el.dataset.paused = "";
      else delete el.dataset.paused;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [anchorX, anchorY, rise, echo, nX, nY, nRise, theme]);

  return <canvas ref={canvas} aria-hidden data-streak className="octo-streak" />;
}
