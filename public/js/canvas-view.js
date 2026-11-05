// PanZoomCanvas — engine pan/zoom/pinch cho sơ đồ bàn.
// - 1 ngón: kéo pan (hoặc kéo bàn trong editor qua callback)
// - 2 ngón: pinch zoom quanh điểm chạm
// - Tap ngắn: chọn bàn / tap nền
// - Double-tap nền: fit toàn cảnh; double-tap bàn: zoom vào bàn
// - Vòng lặp render theo rAF, chỉ vẽ khi dirty (tiết kiệm pin)

const MIN_SCALE = 0.08;
const MAX_SCALE = 6;
const TAP_MS = 350;
const TAP_MOVE_PX = 9;

export class PanZoomCanvas {
  /**
   * @param opts {
   *   draw(ctx, view, now),            // vẽ toàn bộ scene; view={scale,tx,ty,w,h}
   *   hitTest(wx, wy) -> obj|null,     // trả về đối tượng tại điểm world
   *   onTap(obj|null, wpt),            // tap vào bàn hoặc nền
   *   onDoubleTap(obj|null),
   *   onDragObject(obj, wx, wy, phase),// phase: 'start'|'move'|'end' (editor)
   *   allowObjectDrag: bool,
   *   onUserInteract(),                // người dùng tự pan/zoom lần đầu
   * }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.w = 1; this.h = 1;
    this.pointers = new Map();
    this.draggingObj = null;
    this.dragMoved = false;
    this.dirty = true;
    this.anim = null;
    this.lastTap = { t: 0, x: 0, y: 0, id: null };
    this._bind();
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas.parentElement);
    const loop = (now) => {
      if (this.dirty || this._needsAnim(now)) { this._render(now); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _needsAnim() {
    if (!this.anim) return false;
    return true;
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = parent.clientWidth || 1, h = parent.clientHeight || 1;
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.dirty = true;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._cancelAnim();
    if (this.pointers.size === 1) {
      this._start = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.dragMoved = false;
      if (this.opts.allowObjectDrag && this.opts.hitTest) {
        const w = this.screenToWorld(e.clientX, e.clientY);
        const obj = this.opts.hitTest(w.x, w.y);
        if (obj) {
          this.draggingObj = obj;
          this.opts.onDragObject?.(obj, w.x, w.y, 'start');
        }
      }
    } else if (this.pointers.size === 2) {
      this.draggingObj = null;
      this._pinchBase = this._pinchInfo();
    }
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      const info = this._pinchInfo();
      const base = this._pinchBase;
      if (base && info) {
        const factor = info.d / base.d;
        // zoom quanh midpoint + pan theo midpoint
        this.zoomAt(base.mx, base.my, factor, false);
        this.tx += info.mx - base.mx;
        this.ty += info.my - base.my;
        this.dirty = true;
        this.dragMoved = true;
        this.opts.onUserInteract?.();
      }
      this._pinchBase = info;
      return;
    }

    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (Math.hypot(e.clientX - this._start.x, e.clientY - this._start.y) > TAP_MOVE_PX) this.dragMoved = true;

    if (this.draggingObj) {
      const w = this.screenToWorld(e.clientX, e.clientY);
      this.opts.onDragObject?.(this.draggingObj, w.x, w.y, 'move');
      this.dirty = true;
    } else {
      this.tx += dx; this.ty += dy;
      this.dirty = true;
      if (this.dragMoved) this.opts.onUserInteract?.();
    }
  }

  _up(e, cancelled = false) {
    const had = this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1) {
      // rơi từ 2 ngón về 1: reset gốc pan để tránh nhảy
      const [p] = this.pointers.values();
      this._start = { x: p.x, y: p.y, t: performance.now() };
      this.dragMoved = true;
      this._pinchBase = null;
    }
    if (!had) return;

    if (this.draggingObj) {
      const w = this.screenToWorld(e.clientX, e.clientY);
      this.opts.onDragObject?.(this.draggingObj, w.x, w.y, 'end');
      this.draggingObj = null;
      return;
    }

    if (cancelled) return;
    const dt = performance.now() - this._start.t;
    const dist = Math.hypot(e.clientX - this._start.x, e.clientY - this._start.y);
    if (dt < TAP_MS && dist < TAP_MOVE_PX) {
      const w = this.screenToWorld(e.clientX, e.clientY);
      const obj = this.opts.hitTest?.(w.x, w.y) || null;
      // double-tap?
      const now = performance.now();
      const isDouble = now - this.lastTap.t < 320 &&
        Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 36;
      this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      if (isDouble) this.opts.onDoubleTap?.(obj, w);
      else this.opts.onTap?.(obj, w);
    }
  }

  _wheel(e) {
    e.preventDefault();
    this._cancelAnim();
    const factor = Math.pow(1.0018, -e.deltaY);
    this.zoomAt(e.clientX, e.clientY, factor);
  }

  _pinchInfo() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return {
      d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
    };
  }

  zoomAt(sx, sy, factor, clampScale = true) {
    const ns = clampScale ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor)) : this.scale * factor;
    const k = ns / this.scale;
    this.tx = sx - (sx - this.tx) * k;
    this.ty = sy - (sy - this.ty) * k;
    this.scale = ns;
    this.dirty = true;
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }
  worldToScreen(wx, wy) {
    return { x: wx * this.scale + this.tx, y: wy * this.scale + this.ty };
  }

  fit(bounds, padding = 36) {
    const { minX, minY, maxX, maxY } = bounds;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const scale = Math.min((this.w - padding * 2) / bw, (this.h - padding * 2) / bh);
    this.animateTo({
      scale,
      tx: this.w / 2 - (minX + bw / 2) * scale,
      ty: this.h / 2 - (minY + bh / 2) * scale,
    });
  }

  centerOn(wx, wy, targetScale = null) {
    const scale = targetScale ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale)) : this.scale;
    this.animateTo({ scale, tx: this.w / 2 - wx * scale, ty: this.h / 2 - wy * scale });
  }

  animateTo(target, ms = 220) {
    const from = { scale: this.scale, tx: this.tx, ty: this.ty };
    const t0 = performance.now();
    this.anim = { from, to: target, t0, ms };
  }
  _cancelAnim() { this.anim = null; }

  _stepAnim(now) {
    if (!this.anim) return;
    const { from, to, t0, ms } = this.anim;
    let k = Math.min(1, (now - t0) / ms);
    k = 1 - Math.pow(1 - k, 3); // easeOutCubic
    this.scale = from.scale + (to.scale - from.scale) * k;
    this.tx = from.tx + (to.tx - from.tx) * k;
    this.ty = from.ty + (to.ty - from.ty) * k;
    this.dirty = true;
    if (k >= 1) this.anim = null;
  }

  requestRender() { this.dirty = true; }

  _render(now) {
    this._stepAnim(now);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.opts.draw?.(ctx, { scale: this.scale, tx: this.tx, ty: this.ty, w: this.w, h: this.h }, now);
  }
}
