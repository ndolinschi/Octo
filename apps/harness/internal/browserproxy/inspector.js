(() => {
  if (window.__octoBrowserInspectorLoaded) return;
  window.__octoBrowserInspectorLoaded = true;

  const scriptEl =
    document.currentScript || document.querySelector("script[data-octo-nonce]");
  const nonce = (scriptEl && scriptEl.getAttribute("data-octo-nonce")) || "";
  const targetOriginLabel =
    (scriptEl && scriptEl.getAttribute("data-octo-target-origin")) || "";

  const CHANNEL_OUT = "octo-browser";
  const CHANNEL_IN = "octo-browser-host";

  const EDITABLE_PROPS = [
    "color",
    "background-color",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "display",
    "flex-direction",
    "align-items",
    "justify-content",
    "gap",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin",
    "width",
    "height",
    "border-radius",
    "border",
    "opacity",
    "box-shadow",
    "position",
  ];

  const SAFE_ATTRS = new Set([
    "role",
    "type",
    "name",
    "href",
    "src",
    "alt",
    "title",
    "placeholder",
    "value",
    "for",
    "aria-label",
    "aria-expanded",
    "aria-selected",
    "data-testid",
    "data-test",
    "data-cy",
  ]);

  function post(payload, transfer) {
    try {
      window.parent.postMessage(
        Object.assign({ channel: CHANNEL_OUT, nonce }, payload),
        "*",
        transfer || []
      );
    } catch {
      /* parent unavailable */
    }
  }

  function displayUrl() {
    try {
      const loc = window.location;
      if (targetOriginLabel) {
        return targetOriginLabel.replace(/\/$/, "") + loc.pathname + loc.search + loc.hash;
      }
      if (loc.href === "about:srcdoc") {
        const meta = document.querySelector('meta[name="octo-demo-url"]');
        const base = (meta && meta.getAttribute("content")) || "http://localhost:3000";
        return base + (loc.hash || "");
      }
      return loc.href;
    } catch {
      return "";
    }
  }

  function reportNav(kind) {
    post({
      type: kind || "nav",
      url: displayUrl(),
      title: document.title || "",
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  // Hook SPA history mutations so the Browser tab URL bar stays current.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const res = origPush.apply(this, args);
    reportNav("nav");
    return res;
  };
  history.replaceState = function (...args) {
    const res = origReplace.apply(this, args);
    reportNav("nav");
    return res;
  };
  window.addEventListener("popstate", () => reportNav("nav"));
  window.addEventListener("hashchange", () => reportNav("nav"));
  window.addEventListener("load", () => reportNav("nav"));

  // Shadow DOM overlay so host page styles never collide with Design Mode UI.
  let hostEl = null;
  let hoverBox = null;
  let hoverBadge = null;
  let selectedLayer = null;
  let pinsLayer = null;

  function ensureOverlay() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement("div");
    hostEl.setAttribute("data-octo-inspector", "1");
    hostEl.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;margin:0;padding:0;border:0;";
    const shadow = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
      .hover-box {
        position: fixed;
        border: 1.5px solid #4da3ff;
        background: rgba(77, 163, 255, 0.08);
        border-radius: 3px;
        pointer-events: none;
        display: none;
      }
      .hover-badge {
        position: fixed;
        background: #18181b;
        color: #f0f0f0;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 5px;
        padding: 2px 6px;
        font-size: 11px;
        line-height: 16px;
        white-space: nowrap;
        pointer-events: none;
        display: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      }
      .hover-badge .comp { color: #6bb5ff; font-weight: 500; margin-right: 5px; }
      .hover-badge .dim { color: #a2a2a2; margin-left: 5px; font-variant-numeric: tabular-nums; }
      .sel-box {
        position: fixed;
        border: 2px solid #4da3ff;
        background: rgba(77, 163, 255, 0.06);
        border-radius: 3px;
        pointer-events: none;
      }
      .pin {
        position: fixed;
        width: 22px;
        height: 22px;
        margin-left: -11px;
        margin-top: -11px;
        border-radius: 999px;
        background: #18181b;
        color: #f0f0f0;
        border: 1.5px solid rgba(255, 255, 255, 0.75);
        font-size: 11px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        cursor: pointer;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
        user-select: none;
      }
      .pin:hover { transform: scale(1.08); background: #26262c; }
    `;
    hoverBox = document.createElement("div");
    hoverBox.className = "hover-box";
    hoverBadge = document.createElement("div");
    hoverBadge.className = "hover-badge";
    selectedLayer = document.createElement("div");
    pinsLayer = document.createElement("div");
    shadow.append(style, selectedLayer, hoverBox, hoverBadge, pinsLayer);
    (document.body || document.documentElement).appendChild(hostEl);
  }

  function cssEscapeIdent(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function buildSelector(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) {
      const byId = "#" + cssEscapeIdent(el.id);
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch {
        /* fallback */
      }
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += "#" + cssEscapeIdent(cur.id);
        parts.unshift(part);
        break;
      }
      const cls = Array.from(cur.classList)
        .filter((c) => c && !c.includes(":") && c.length < 32)
        .slice(0, 2);
      if (cls.length) {
        part += "." + cls.map(cssEscapeIdent).join(".");
      }
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (s) => s.tagName === cur.tagName
        );
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length >= 6) break;
    }
    return parts.join(" > ");
  }

  function extractComponent(el) {
    // 1. Explicit demo/debug attribute
    const explicit = el.closest("[data-octo-component]");
    if (explicit) {
      const stack = [];
      let p = explicit;
      while (p) {
        const name = p.getAttribute("data-octo-component");
        if (name && stack[stack.length - 1] !== name) stack.push(name);
        p = p.parentElement ? p.parentElement.closest("[data-octo-component]") : null;
      }
      const file = explicit.getAttribute("data-octo-source") || undefined;
      return { name: stack[0], stack: stack.slice(0, 6), file };
    }
    // 2. React Fiber (__reactFiber$*)
    const keys = Object.keys(el);
    const fiberKey = keys.find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (fiberKey) {
      let fiber = el[fiberKey];
      const stack = [];
      let sourceFile;
      let sourceLine;
      let guard = 0;
      while (fiber && guard++ < 40) {
        const t = fiber.type;
        let name = "";
        if (typeof t === "function") {
          name = t.displayName || t.name || "";
        } else if (t && typeof t === "object") {
          name =
            t.displayName ||
            (t.render && (t.render.displayName || t.render.name)) ||
            "";
        }
        if (name && !/^[a-z]/.test(name) && stack[stack.length - 1] !== name) {
          stack.push(name);
          if (!sourceFile && fiber._debugSource) {
            sourceFile = fiber._debugSource.fileName;
            sourceLine = fiber._debugSource.lineNumber;
          }
        }
        fiber = fiber.return;
      }
      if (stack.length) {
        return {
          name: stack[0],
          stack: stack.slice(0, 6),
          file: sourceFile,
          line: sourceLine,
        };
      }
    }
    // 3. Vue 3 (__vueParentComponent)
    if (el.__vueParentComponent) {
      let comp = el.__vueParentComponent;
      const stack = [];
      let file;
      let guard = 0;
      while (comp && guard++ < 30) {
        const t = comp.type || {};
        const name = t.__name || t.name || "";
        if (name && stack[stack.length - 1] !== name) {
          stack.push(name);
          if (!file && t.__file) file = t.__file;
        }
        comp = comp.parent;
      }
      if (stack.length) return { name: stack[0], stack: stack.slice(0, 6), file };
    }
    // 4. Svelte (__svelte_meta)
    if (el.__svelte_meta && el.__svelte_meta.loc) {
      const loc = el.__svelte_meta.loc;
      const file = loc.file || undefined;
      const name = file ? file.split("/").pop().replace(/\.svelte$/, "") : "SvelteComponent";
      return { name, stack: [name], file, line: loc.line };
    }
    return undefined;
  }

  function describeElement(el) {
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of Array.from(el.attributes)) {
      if (SAFE_ATTRS.has(a.name) || a.name.startsWith("data-test")) {
        attrs[a.name] = a.value.slice(0, 120);
      }
    }
    const editableStyles = {};
    for (const prop of EDITABLE_PROPS) {
      editableStyles[prop] = cs.getPropertyValue(prop).trim();
    }
    const rawText = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const comp = extractComponent(el);
    const out = {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: Array.from(el.classList).slice(0, 12),
      attributes: attrs,
      text: rawText.slice(0, 200),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      pageRect: {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      styles: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        display: cs.display,
        position: cs.position,
      },
      editableStyles,
    };
    if (comp) out.component = comp;
    return out;
  }

  // Design Mode interactive state
  let designActive = false;
  let interactivePick = false;
  let hoveredEl = null;
  let walkStack = [];
  let lastPointer = { x: -999, y: -999 };
  let selectedSelectors = [];
  let activePins = [];
  let editingState = null; // { el, before }
  const originalInlineStyles = new WeakMap();

  function renderHover() {
    ensureOverlay();
    if (!designActive || !interactivePick || !hoveredEl || editingState) {
      hoverBox.style.display = "none";
      hoverBadge.style.display = "none";
      return;
    }
    const r = hoveredEl.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) {
      hoverBox.style.display = "none";
      hoverBadge.style.display = "none";
      return;
    }
    hoverBox.style.display = "block";
    hoverBox.style.left = `${r.left}px`;
    hoverBox.style.top = `${r.top}px`;
    hoverBox.style.width = `${r.width}px`;
    hoverBox.style.height = `${r.height}px`;

    const comp = extractComponent(hoveredEl);
    const tagLabel =
      hoveredEl.tagName.toLowerCase() +
      (hoveredEl.id ? `#${hoveredEl.id}` : hoveredEl.classList[0] ? `.${hoveredEl.classList[0]}` : "");
    hoverBadge.replaceChildren();
    if (comp && comp.name) {
      const cSpan = document.createElement("span");
      cSpan.className = "comp";
      cSpan.textContent = `<${comp.name}>`;
      hoverBadge.appendChild(cSpan);
    }
    hoverBadge.appendChild(document.createTextNode(tagLabel));
    const dSpan = document.createElement("span");
    dSpan.className = "dim";
    dSpan.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
    hoverBadge.appendChild(dSpan);

    hoverBadge.style.display = "block";
    const badgeTop = r.top >= 26 ? r.top - 24 : Math.min(window.innerHeight - 24, r.bottom + 4);
    const badgeLeft = Math.max(4, Math.min(window.innerWidth - 180, r.left));
    hoverBadge.style.left = `${badgeLeft}px`;
    hoverBadge.style.top = `${badgeTop}px`;
  }

  function renderSelected() {
    ensureOverlay();
    selectedLayer.replaceChildren();
    if (!designActive && selectedSelectors.length === 0) return;
    for (const sel of selectedSelectors) {
      if (!sel) continue;
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.className = "sel-box";
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      selectedLayer.appendChild(box);
    }
  }

  function renderPins() {
    ensureOverlay();
    pinsLayer.replaceChildren();
    for (const pin of activePins) {
      let cx = null;
      let cy = null;
      if (pin.selector) {
        try {
          const el = document.querySelector(pin.selector);
          if (el) {
            const r = el.getBoundingClientRect();
            cx = Math.min(window.innerWidth - 14, Math.max(14, r.right - 2));
            cy = Math.max(14, r.top + 2);
          }
        } catch {
          /* ignore */
        }
      }
      if (cx === null && pin.pageRect) {
        const rx = pin.pageRect.x - window.scrollX;
        const ry = pin.pageRect.y - window.scrollY;
        cx = Math.min(window.innerWidth - 14, Math.max(14, rx + pin.pageRect.width - 2));
        cy = Math.max(14, ry + 2);
      }
      if (cx === null || cy === null) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pin";
      btn.textContent = String(pin.number);
      btn.style.left = `${cx}px`;
      btn.style.top = `${cy}px`;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        post({
          type: "pinClick",
          noteId: pin.id,
          clientRect: { x: cx, y: cy, width: 22, height: 22 },
        });
      });
      pinsLayer.appendChild(btn);
    }
  }

  function refreshOverlays() {
    renderHover();
    renderSelected();
    renderPins();
  }

  window.addEventListener("scroll", refreshOverlays, { capture: true, passive: true });
  window.addEventListener("resize", () => {
    refreshOverlays();
    reportNav("nav");
  });

  function isTextEditableElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select", "img", "svg", "canvas", "video", "iframe"].includes(tag)) {
      return false;
    }
    const text = (el.innerText || "").trim();
    if (!text || text.length > 500) return false;
    // Prefer leaf or mostly inline text elements
    const blockChildren = Array.from(el.children).filter((c) => {
      const d = window.getComputedStyle(c).display;
      return d === "block" || d === "flex" || d === "grid";
    });
    return blockChildren.length === 0;
  }

  function finishTextEdit(commit, stageToChat) {
    if (!editingState) return;
    const { el, before } = editingState;
    editingState = null;
    el.removeAttribute("contenteditable");
    el.style.outline = "";
    el.style.outlineOffset = "";
    const after = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!commit || after === before) {
      el.innerText = before;
      post({ type: "textEditCancelled" });
      return;
    }
    const info = describeElement(el);
    post({
      type: "textEditSaved",
      element: info,
      before,
      after,
      stageToChat: Boolean(stageToChat),
      clientRect: info.rect,
    });
  }

  function startTextEdit(el) {
    if (editingState) finishTextEdit(true, false);
    const before = (el.innerText || "").replace(/\s+/g, " ").trim();
    editingState = { el, before };
    hoverBox.style.display = "none";
    hoverBadge.style.display = "none";
    el.setAttribute("contenteditable", "true");
    el.style.outline = "2px solid #4da3ff";
    el.style.outlineOffset = "2px";
    el.focus();
    post({ type: "textEditStart", selector: buildSelector(el) });
  }

  let clickTimer = null;

  window.addEventListener(
    "pointermove",
    (e) => {
      if (!designActive || !interactivePick || editingState) return;
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      if (dx * dx + dy * dy < 9) return;
      lastPointer = { x: e.clientX, y: e.clientY };
      walkStack = [];
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (
        !target ||
        target === document.documentElement ||
        (hostEl && hostEl.contains(target))
      ) {
        hoveredEl = null;
      } else {
        hoveredEl = target;
      }
      renderHover();
    },
    true
  );

  window.addEventListener(
    "click",
    (e) => {
      if (!designActive || !interactivePick) return;
      if (editingState && editingState.el.contains(e.target)) return;
      if (editingState) {
        e.preventDefault();
        e.stopPropagation();
        finishTextEdit(true, false);
        return;
      }
      const target =
        hoveredEl ||
        (e.target instanceof Element ? e.target : null);
      if (!target || (hostEl && hostEl.contains(target))) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.detail === 2 && !e.shiftKey && !e.altKey && isTextEditableElement(target)) {
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        startTextEdit(target);
        return;
      }

      const picked = describeElement(target);
      const shiftKey = e.shiftKey;
      const altKey = e.altKey;
      if (!shiftKey && !altKey && isTextEditableElement(target)) {
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          clickTimer = null;
          post({
            type: "pick",
            element: picked,
            shiftKey: false,
            altKey: false,
            clientRect: picked.rect,
          });
        }, 180);
      } else {
        post({
          type: "pick",
          element: picked,
          shiftKey,
          altKey,
          clientRect: picked.rect,
        });
      }
    },
    true
  );

  function walkDom(direction) {
    if (!hoveredEl) return;
    if (direction === "up") {
      const p = hoveredEl.parentElement;
      if (p && p !== document.documentElement) {
        walkStack.push(hoveredEl);
        hoveredEl = p;
        renderHover();
      }
    } else if (direction === "down") {
      if (walkStack.length > 0) {
        hoveredEl = walkStack.pop();
        renderHover();
      } else if (hoveredEl.firstElementChild) {
        hoveredEl = hoveredEl.firstElementChild;
        renderHover();
      }
    }
  }

  window.addEventListener(
    "keydown",
    (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        e.stopPropagation();
        post({ type: "shortcut", key: "toggleDesign" });
        return;
      }
      if (!designActive) return;

      if (editingState) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finishTextEdit(false, false);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          finishTextEdit(true, false);
          return;
        }
        if (mod && e.key.toLowerCase() === "l") {
          e.preventDefault();
          e.stopPropagation();
          finishTextEdit(true, true);
          return;
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        post({ type: "shortcut", key: "escape" });
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        post({ type: "shortcut", key: "undo" });
        return;
      }
      if (interactivePick && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        walkDom(e.key === "ArrowUp" ? "up" : "down");
      }
    },
    true
  );

  function applyCssOverride(selector, property, value) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      return;
    }
    if (!(el instanceof HTMLElement)) return;
    let map = originalInlineStyles.get(el);
    if (!map) {
      map = new Map();
      originalInlineStyles.set(el, map);
    }
    if (!map.has(property)) {
      map.set(property, {
        val: el.style.getPropertyValue(property),
        pri: el.style.getPropertyPriority(property),
      });
    }
    if (value === null) {
      const orig = map.get(property);
      if (orig && orig.val) el.style.setProperty(property, orig.val, orig.pri);
      else el.style.removeProperty(property);
    } else {
      el.style.setProperty(property, value);
    }
    refreshOverlays();
  }

  function drawStrokes(ctx, strokes, offsetX, offsetY) {
    if (!Array.isArray(strokes) || !strokes.length) return;
    ctx.save();
    for (const s of strokes) {
      ctx.strokeStyle = s.color || "#f17878";
      ctx.lineWidth = s.width || 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (s.kind === "draw" && Array.isArray(s.points) && s.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x - offsetX, s.points[0].y - offsetY);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x - offsetX, s.points[i].y - offsetY);
        }
        ctx.stroke();
      } else if (s.kind === "rect") {
        const x = Math.min(s.x1, s.x2) - offsetX;
        const y = Math.min(s.y1, s.y2) - offsetY;
        ctx.strokeRect(x, y, Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
      } else if (s.kind === "ellipse") {
        const cx = (s.x1 + s.x2) / 2 - offsetX;
        const cy = (s.y1 + s.y2) / 2 - offsetY;
        const rx = Math.max(1, Math.abs(s.x2 - s.x1) / 2);
        const ry = Math.max(1, Math.abs(s.y2 - s.y1) / 2);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.kind === "arrow") {
        const x1 = s.x1 - offsetX;
        const y1 = s.y1 - offsetY;
        const x2 = s.x2 - offsetX;
        const y2 = s.y2 - offsetY;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = 11;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - head * Math.cos(angle - Math.PI / 6),
          y2 - head * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - head * Math.cos(angle + Math.PI / 6),
          y2 - head * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function renderFallbackScene(ctx, cropX, cropY, cropW, cropH) {
    const bodyBg = window.getComputedStyle(document.body || document.documentElement).backgroundColor;
    ctx.fillStyle = bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" ? bodyBg : "#ffffff";
    ctx.fillRect(0, 0, cropW, cropH);

    const nodes = Array.from(document.body ? document.body.querySelectorAll("*") : []);
    for (const el of nodes.slice(0, 250)) {
      if (hostEl && hostEl.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (
        r.width <= 0 ||
        r.height <= 0 ||
        r.right < cropX ||
        r.left > cropX + cropW ||
        r.bottom < cropY ||
        r.top > cropY + cropH
      ) {
        continue;
      }
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) {
        continue;
      }
      const x = r.left - cropX;
      const y = r.top - cropY;
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
        ctx.fillStyle = cs.backgroundColor;
        ctx.fillRect(x, y, r.width, r.height);
      }
      const bw = parseFloat(cs.borderTopWidth) || 0;
      if (bw > 0 && cs.borderTopColor && cs.borderTopColor !== "rgba(0, 0, 0, 0)") {
        ctx.strokeStyle = cs.borderTopColor;
        ctx.lineWidth = Math.min(4, bw);
        ctx.strokeRect(x, y, r.width, r.height);
      }
      if (el.children.length === 0) {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (txt) {
          ctx.fillStyle = cs.color || "#111111";
          ctx.font = `${cs.fontWeight || "400"} ${cs.fontSize || "13px"} sans-serif`;
          ctx.textBaseline = "top";
          const padL = parseFloat(cs.paddingLeft) || 0;
          const padT = parseFloat(cs.paddingTop) || 0;
          ctx.fillText(txt.slice(0, 80), x + padL, y + padT, Math.max(20, r.width - padL));
        }
      }
    }
  }

  async function captureCrop(requestId, rect, strokes) {
    let targetRect = rect;
    if (selectedSelectors.length === 1 && (!Array.isArray(strokes) || strokes.length === 0)) {
      try {
        const liveEl = document.querySelector(selectedSelectors[0]);
        if (liveEl) {
          const lr = liveEl.getBoundingClientRect();
          if (lr.width > 0 && lr.height > 0) {
            targetRect = {
              x: Math.round(lr.left),
              y: Math.round(lr.top),
              width: Math.round(lr.width),
              height: Math.round(lr.height),
            };
          }
        }
      } catch {
        /* keep rect */
      }
    }
    const pad = 12;
    const x = Math.max(0, Math.floor((targetRect.x || 0) - pad));
    const y = Math.max(0, Math.floor((targetRect.y || 0) - pad));
    const w = Math.max(24, Math.min(1600, Math.ceil((targetRect.width || 120) + pad * 2)));
    const h = Math.max(24, Math.min(1200, Math.ceil((targetRect.height || 80) + pad * 2)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      post({ type: "cropResult", requestId, pngBytes: null, width: 0, height: 0 });
      return;
    }
    ctx.scale(dpr, dpr);

    let renderedSvg = false;
    try {
      const vw = Math.max(
        window.innerWidth || 0,
        document.documentElement.clientWidth || 0,
        x + w
      );
      const docX = x + (window.scrollX || 0);
      const docY = y + (window.scrollY || 0);
      const vh = Math.max(
        (window.innerHeight || 0) + (window.scrollY || 0),
        document.documentElement.scrollHeight || 0,
        docY + h
      );
      const clone = document.documentElement.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      let externalCss = "";
      for (const sheet of Array.from(document.styleSheets || [])) {
        if (sheet.ownerNode && sheet.ownerNode.tagName === "STYLE") continue;
        try {
          const rules = Array.from(sheet.cssRules || []);
          externalCss += rules.map((r) => r.cssText).join("\n") + "\n";
        } catch {
          /* cross-origin sheet */
        }
      }
      clone
        .querySelectorAll(
          "script, iframe, [data-octo-inspector], link[rel='preload'], link[rel='stylesheet']"
        )
        .forEach((n) => n.remove());
      if (externalCss) {
        const inlined = document.createElement("style");
        inlined.textContent = externalCss;
        (clone.querySelector("head") || clone).appendChild(inlined);
      }
      clone.style.width = `${vw}px`;
      clone.style.margin = "0";
      clone.style.transform = `translate(${-docX}px, ${-docY}px)`;
      clone.style.transformOrigin = "top left";
      const serialized = new XMLSerializer().serializeToString(clone);
      const svgW = Math.round(w * dpr);
      const svgH = Math.round(h * dpr);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${vw}" height="${vh}">${serialized}</foreignObject></svg>`;
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      const img = new Image();
      img.decoding = "sync";
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 800);
        img.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        img.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        img.src = url;
      });
      ctx.drawImage(img, 0, 0, w, h);
      // Verify canvas is not tainted before exporting
      canvas.toDataURL("image/png");
      renderedSvg = true;
    } catch {
      renderedSvg = false;
    }

    let outCanvas = canvas;
    let outCtx = ctx;
    if (!renderedSvg) {
      outCanvas = document.createElement("canvas");
      outCanvas.width = Math.round(w * dpr);
      outCanvas.height = Math.round(h * dpr);
      outCtx = outCanvas.getContext("2d");
      outCtx.scale(dpr, dpr);
      renderFallbackScene(outCtx, x, y, w, h);
    }

    drawStrokes(outCtx, strokes, x, y);

    outCanvas.toBlob((blob) => {
      if (!blob) {
        post({ type: "cropResult", requestId, pngBytes: null, width: 0, height: 0 });
        return;
      }
      blob.arrayBuffer().then(
        (buf) =>
          post(
            {
              type: "cropResult",
              requestId,
              pngBytes: buf,
              width: outCanvas.width,
              height: outCanvas.height,
            },
            [buf]
          ),
        () => post({ type: "cropResult", requestId, pngBytes: null, width: 0, height: 0 })
      );
    }, "image/png");
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object" || msg.channel !== CHANNEL_IN) return;
    if (nonce && msg.nonce !== nonce) return;

    switch (msg.type) {
      case "nav":
        if (msg.action === "back") history.back();
        else if (msg.action === "forward") history.forward();
        else if (msg.action === "reload") window.location.reload();
        break;
      case "setDesignMode":
        designActive = Boolean(msg.active);
        interactivePick = Boolean(msg.active && msg.interactivePick);
        if (!designActive) {
          hoveredEl = null;
          walkStack = [];
          selectedSelectors = [];
          if (editingState) finishTextEdit(false, false);
        }
        refreshOverlays();
        break;
      case "setSelected":
        selectedSelectors = Array.isArray(msg.selectors) ? msg.selectors : [];
        renderSelected();
        break;
      case "walkElement":
        if (msg.direction === "up" || msg.direction === "down") walkDom(msg.direction);
        break;
      case "applyCss":
        if (typeof msg.selector === "string" && typeof msg.property === "string") {
          applyCssOverride(
            msg.selector,
            msg.property,
            typeof msg.value === "string" ? msg.value : null
          );
        }
        break;
      case "revertCss":
        if (Array.isArray(msg.edits)) {
          for (const ed of msg.edits) {
            if (ed && typeof ed.selector === "string" && typeof ed.property === "string") {
              applyCssOverride(ed.selector, ed.property, null);
            }
          }
        }
        break;
      case "revertText":
        if (typeof msg.selector === "string" && typeof msg.originalText === "string") {
          try {
            const el = document.querySelector(msg.selector);
            if (el instanceof HTMLElement) el.innerText = msg.originalText;
          } catch {
            /* ignore */
          }
        }
        break;
      case "setPins":
        activePins = Array.isArray(msg.pins) ? msg.pins : [];
        renderPins();
        break;
      case "captureCrop":
        if (typeof msg.requestId === "string" && msg.rect) {
          void captureCrop(msg.requestId, msg.rect, msg.strokes || []);
        }
        break;
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureOverlay();
      reportNav("ready");
    });
  } else {
    ensureOverlay();
    reportNav("ready");
  }
})();
