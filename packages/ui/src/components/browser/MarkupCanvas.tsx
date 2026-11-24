import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { MarkupPoint, MarkupStroke, Rect } from "../../lib/browser/designNotes";
import { useApp } from "../../state/app";
import type { DesignTool } from "./DesignHintBar";

function constrainBox(startX: number, startY: number, curX: number, curY: number, shift: boolean, alt: boolean) {
  let dx = curX - startX;
  let dy = curY - startY;
  if (shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (alt) {
    return { x1: startX - dx, y1: startY - dy, x2: startX + dx, y2: startY + dy };
  }
  return { x1: startX, y1: startY, x2: startX + dx, y2: startY + dy };
}

function constrainArrow(startX: number, startY: number, curX: number, curY: number, shift: boolean, alt: boolean) {
  let dx = curX - startX;
  let dy = curY - startY;
  if (shift) {
    const dist = Math.hypot(dx, dy);
    const snap = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    dx = Math.cos(snap) * dist;
    dy = Math.sin(snap) * dist;
  }
  if (alt) {
    return { x1: startX - dx, y1: startY - dy, x2: startX + dx, y2: startY + dy };
  }
  return { x1: startX, y1: startY, x2: startX + dx, y2: startY + dy };
}

function drawStroke(ctx: CanvasRenderingContext2D, s: MarkupStroke, defaultColor: string) {
  ctx.save();
  ctx.strokeStyle = s.color ?? defaultColor;
  ctx.lineWidth = s.width ?? 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.kind === "draw") {
    const first = s.points[0];
    if (first && s.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < s.points.length; i++) {
        const pt = s.points[i];
        if (pt) ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }
  } else if (s.kind === "rect") {
    ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  } else if (s.kind === "ellipse") {
    const cx = (s.x1 + s.x2) / 2;
    const cy = (s.y1 + s.y2) / 2;
    const rx = Math.max(1, Math.abs(s.x2 - s.x1) / 2);
    const ry = Math.max(1, Math.abs(s.y2 - s.y1) / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = 11;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 6), s.y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 6), s.y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
  ctx.restore();
}

export function boundsOfStrokes(strokes: readonly MarkupStroke[]): Rect | undefined {
  if (!strokes.length) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    if (s.kind === "draw") {
      for (const p of s.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    } else {
      minX = Math.min(minX, s.x1, s.x2);
      minY = Math.min(minY, s.y1, s.y2);
      maxX = Math.max(maxX, s.x1, s.x2);
      maxY = Math.max(maxY, s.y1, s.y2);
    }
  }
  if (!Number.isFinite(minX)) return undefined;
  return {
    x: Math.max(0, Math.round(minX - 8)),
    y: Math.max(0, Math.round(minY - 8)),
    width: Math.max(24, Math.round(maxX - minX + 16)),
    height: Math.max(24, Math.round(maxY - minY + 16)),
  };
}

/**
 * Transparent canvas over the preview frame for Area drag selection and Freehand / Shape / Arrow markup.
 * Pointer events are enabled only when `tool !== "select"` so normal DOM picking works unimpeded.
 */
export function MarkupCanvas(props: {
  tool: DesignTool;
  strokes: readonly MarkupStroke[];
  area: Rect | null;
  onAreaSelected(rect: Rect): void;
  onAddStroke(stroke: MarkupStroke): void;
}) {
  const { theme } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draftArea, setDraftArea] = useState<Rect | null>(null);
  const [draftStroke, setDraftStroke] = useState<MarkupStroke | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; points: MarkupPoint[] } | null>(null);

  const interactive = props.tool !== "select";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const paint = () => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cs = getComputedStyle(canvas);
      const strokeColor = cs.getPropertyValue("--octo-err").trim() || "currentColor";
      const areaStroke = cs.getPropertyValue("--octo-drop-edge").trim() || "currentColor";
      const areaFill = cs.getPropertyValue("--octo-drop").trim() || "transparent";

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const shownArea = draftArea ?? props.area;
      if (shownArea) {
        ctx.save();
        ctx.strokeStyle = areaStroke;
        ctx.fillStyle = areaFill;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.fillRect(shownArea.x, shownArea.y, shownArea.width, shownArea.height);
        ctx.strokeRect(shownArea.x, shownArea.y, shownArea.width, shownArea.height);
        ctx.restore();
      }

      for (const s of props.strokes) drawStroke(ctx, s, strokeColor);
      if (draftStroke) drawStroke(ctx, draftStroke, strokeColor);
    };

    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [props.strokes, props.area, draftArea, draftStroke, theme]);

  const localPoint = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!interactive || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = localPoint(e);
    dragRef.current = { startX: pt.x, startY: pt.y, points: [pt] };
    if (props.tool === "draw") {
      setDraftStroke({ kind: "draw", points: [pt], width: 2.5 });
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pt = localPoint(e);
    if (props.tool === "area") {
      const box = constrainBox(drag.startX, drag.startY, pt.x, pt.y, e.shiftKey, e.altKey);
      setDraftArea({
        x: Math.round(Math.min(box.x1, box.x2)),
        y: Math.round(Math.min(box.y1, box.y2)),
        width: Math.round(Math.abs(box.x2 - box.x1)),
        height: Math.round(Math.abs(box.y2 - box.y1)),
      });
    } else if (props.tool === "draw") {
      drag.points.push(pt);
      setDraftStroke({ kind: "draw", points: [...drag.points], width: 2.5 });
    } else if (props.tool === "arrow") {
      const line = constrainArrow(drag.startX, drag.startY, pt.x, pt.y, e.shiftKey, e.altKey);
      setDraftStroke({ kind: "arrow", ...line, width: 2.5 });
    } else if (props.tool === "rect" || props.tool === "ellipse") {
      const box = constrainBox(drag.startX, drag.startY, pt.x, pt.y, e.shiftKey, e.altKey);
      setDraftStroke({ kind: props.tool, ...box, width: 2.5 });
    }
  };

  const finishDrag = () => {
    const area = draftArea;
    const stroke = draftStroke;
    dragRef.current = null;
    setDraftArea(null);
    setDraftStroke(null);
    if (props.tool === "area" && area && area.width >= 8 && area.height >= 8) {
      props.onAreaSelected(area);
    } else if (stroke) {
      if (stroke.kind === "draw" && stroke.points.length < 2) return;
      if (stroke.kind !== "draw" && Math.hypot(stroke.x2 - stroke.x1, stroke.y2 - stroke.y1) < 6) return;
      props.onAddStroke(stroke);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      data-markup-canvas
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={() => {
        dragRef.current = null;
        setDraftArea(null);
        setDraftStroke(null);
      }}
      className={interactive ? "absolute inset-0 z-10 h-full w-full cursor-crosshair touch-none" : "pointer-events-none absolute inset-0 z-10 h-full w-full"}
    />
  );
}
