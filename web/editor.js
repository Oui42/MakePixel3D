// Edytor pikseli na podglądzie sprite'a: ołówek, gumka, pipeta, cofnij/ponów.
// Poprawki NIE zmieniają samego renderu – trzymamy je jako osobną warstwę (Map: indeks piksela → [r, g, b, a])
// dla danego kierunku i kadru. app.js nakłada warstwy po każdym przeliczeniu, więc zmiana kolorów/palety
// poprawek nie kasuje. Tu jest tylko obsługa myszy, rysowanie na bieżącym obrazku i historia zmian.

export class PixelEditor {
  /**
   * @param view     canvas z podglądem sprite'a (piksele 1:1, powiększony przez CSS)
   * @param overlay  canvas nad nim – siatka i podświetlenie piksela pod kursorem
   * @param hooks    { target() → { img, layer, key } | null, color() → [r,g,b], onPaint(), onCommit(), onPick([r,g,b]) }
   */
  constructor(view, overlay, hooks) {
    this.view = view;
    this.overlay = overlay;
    this.hooks = hooks;
    this.enabled = false;
    this.tool = 'pencil';
    this.color = [0, 0, 0];
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;
    this.hover = null;

    view.addEventListener('pointerdown', (e) => this.#down(e));
    view.addEventListener('pointermove', (e) => this.#move(e));
    view.addEventListener('pointerup', () => this.#up());
    view.addEventListener('pointercancel', () => this.#up());
    view.addEventListener('pointerleave', () => { this.hover = null; this.drawOverlay(); });
  }

  setEnabled(on) {
    this.enabled = on;
    this.view.classList.toggle('editing', on);
    if (!on) this.#up();
    this.drawOverlay();
  }

  /** Piksel pod kursorem (współrzędne sprite'a) albo null poza obrazkiem. */
  #cell(e) {
    const r = this.view.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.view.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.view.height);
    return x >= 0 && y >= 0 && x < this.view.width && y < this.view.height ? { x, y } : null;
  }

  #down(e) {
    if (!this.enabled || e.button !== 0) return;
    const cell = this.#cell(e);
    const t = this.hooks.target();
    if (!cell || !t) return;
    if (this.tool === 'picker') {
      const i = (cell.y * t.img.width + cell.x) * 4;
      if (t.img.data[i + 3]) {
        this.color = [t.img.data[i], t.img.data[i + 1], t.img.data[i + 2]];
        this.hooks.onPick(this.color);
      }
      return;
    }
    this.view.setPointerCapture(e.pointerId);
    this.stroke = { t, changes: new Map(), last: cell };
    this.#paint(cell);
  }

  #move(e) {
    if (!this.enabled) return;
    const cell = this.#cell(e);
    this.hover = cell;
    if (this.stroke && cell) {
      // linia od poprzedniej pozycji (Bresenham) – szybki ruch myszą nie zostawia przerw
      let { x: x0, y: y0 } = this.stroke.last;
      const { x: x1, y: y1 } = cell;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.#paint({ x: x0, y: y0 });
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      this.stroke.last = cell;
    }
    this.drawOverlay();
  }

  #paint({ x, y }) {
    const { img, layer } = this.stroke.t;
    const p = y * img.width + x;
    const color = this.hooks.color?.() ?? this.color;   // kolor z pola w interfejsie (jeśli podany)
    const next = this.tool === 'eraser' ? [0, 0, 0, 0] : [...color, 255];
    if (!this.stroke.changes.has(p)) this.stroke.changes.set(p, layer.get(p));   // stan sprzed pociągnięcia
    layer.set(p, next);
    img.data.set(next, p * 4);
    this.hooks.onPaint();
  }

  #up() {
    if (!this.stroke) return;
    const { t, changes } = this.stroke;
    this.stroke = null;
    if (!changes.size) return;
    this.undoStack.push({ key: t.key, changes: [...changes].map(([p, prev]) => [p, prev, t.layer.get(p)]) });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.hooks.onCommit();
  }

  /** Zapis zmiany zrobionej poza pędzlem (np. „wyczyść poprawki”) – żeby dało się ją cofnąć. */
  record(key, changes) {
    if (!changes.length) return;
    this.undoStack.push({ key, changes });
    this.redoStack = [];
  }

  /** Cofnij / ponów: zwraca wpis { key, changes: [[piksel, przed, po]] }; zastosowanie robi app.js. */
  undo() {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry ? { key: entry.key, values: entry.changes.map(([p, prev]) => [p, prev]) } : null;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry ? { key: entry.key, values: entry.changes.map(([p, , next]) => [p, next]) } : null;
  }

  /** Siatka pikseli (gdy komórki są wystarczająco duże) + ramka piksela pod kursorem. */
  drawOverlay() {
    const o = this.overlay, v = this.view;
    const r = v.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    o.style.width = v.style.width;
    o.style.height = v.style.height;
    o.width = Math.max(1, Math.round(r.width * dpr));
    o.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, o.width, o.height);
    if (!this.enabled || !v.width) return;
    const cw = o.width / v.width, ch = o.height / v.height;
    if (cw >= 6) {
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < v.width; x++) { const px = Math.round(x * cw) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, o.height); }
      for (let y = 1; y < v.height; y++) { const py = Math.round(y * ch) + 0.5; ctx.moveTo(0, py); ctx.lineTo(o.width, py); }
      ctx.stroke();
    }
    if (this.hover) {
      ctx.lineWidth = Math.max(2, dpr * 2);
      ctx.strokeStyle = this.tool === 'eraser' ? '#ff5577' : '#9b78ff';
      ctx.strokeRect(this.hover.x * cw + 1, this.hover.y * ch + 1, cw - 2, ch - 2);
    }
  }
}
