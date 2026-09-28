// Maska tła: przycinanie obiektu ze zdjęcia + okno ręcznej poprawki (pędzel „przywróć” / „usuń”).
// Źródłem jest CAŁE zdjęcie z serwera: kolory nietknięte, maska obiektu w kanale alfa.

const ALPHA_NOISE = 16;   // jak na serwerze: słabsza alfa = tło
const CROP_PAD = 0.04;    // margines wokół obiektu po przycięciu

export async function imageDataFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

export function imageDataToBlob(imageData) {
  const c = new OffscreenCanvas(imageData.width, imageData.height);
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

/** Obiekt przycięty do swojego obrysu (z małym marginesem); tło w pełni przezroczyste. null = pusta maska. */
export function cropToObject(src) {
  const { width: w, height: h, data } = src;
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] >= ALPHA_NOISE) {
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) return null;
  const pad = Math.round(Math.max(x2 - x1, y2 - y1) * CROP_PAD);
  x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad);
  x2 = Math.min(w - 1, x2 + pad); y2 = Math.min(h - 1, y2 + pad);
  const cw = x2 - x1 + 1, ch = y2 - y1 + 1;
  const out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    const row = ((y + y1) * w + x1) * 4;
    out.data.set(data.subarray(row, row + cw * 4), y * cw * 4);
  }
  // kolory tła zerujemy – w wycięciu mają być tylko piksele obiektu
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] < ALPHA_NOISE) out.data[i] = out.data[i + 1] = out.data[i + 2] = out.data[i + 3] = 0;
  }
  return out;
}

/**
 * Okno poprawki maski. open(source) → Promise<ImageData | null> (null = anulowano).
 * Elementy okna (index.html): #maskDialog, #maskCanvas, #maskCursor, #maskTool (select data-seg),
 * #maskBrush (suwak), #maskUndo, #maskReset, #maskCancel, #maskApply.
 */
export class MaskEditor {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.dialog = $('maskDialog');
    this.canvas = $('maskCanvas');
    this.cursor = $('maskCursor');
    this.ctx = this.canvas.getContext('2d');
    this.el = { tool: $('maskTool'), brush: $('maskBrush'), brushOut: $('maskBrushOut'), undo: $('maskUndo'),
      reset: $('maskReset'), cancel: $('maskCancel'), apply: $('maskApply') };
    this.undoStack = [];
    this.painting = false;

    this.canvas.addEventListener('pointerdown', (e) => this.#down(e));
    this.canvas.addEventListener('pointermove', (e) => this.#move(e));
    this.canvas.addEventListener('pointerup', () => this.#up());
    this.canvas.addEventListener('pointercancel', () => this.#up());
    this.canvas.addEventListener('pointerleave', () => { this.cursor.hidden = true; });
    this.el.brush.addEventListener('input', () => { this.el.brushOut.textContent = `${this.el.brush.value} px`; });
    this.el.undo.addEventListener('click', () => this.#undo());
    this.el.reset.addEventListener('click', () => {
      this.#pushUndo();
      this.mask.set(this.aiMask);
      this.#render();
    });
    this.el.cancel.addEventListener('click', () => this.#close(null));
    this.el.apply.addEventListener('click', () => this.#close(this.#result()));
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.#close(null); });   // Esc
    this.dialog.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.#undo(); }
      if (e.key === '[' || e.key === ']') {
        const b = this.el.brush;
        b.value = Number(b.value) + (e.key === ']' ? 4 : -4);
        b.dispatchEvent(new Event('input'));
      }
    });
    this.el.brushOut.textContent = `${this.el.brush.value} px`;
    // obraz zawsze w całości w oknie – także na małym ekranie i po zmianie rozmiaru okna
    new ResizeObserver(() => this.#fit()).observe(this.canvas.parentElement);
  }

  /** Wpasowanie obrazu w dostępny obszar z zachowaniem proporcji (CSS max-width/height tu nie wystarcza). */
  #fit() {
    const stage = this.canvas.parentElement;
    const w = this.canvas.width, h = this.canvas.height;
    if (!w || !stage.clientWidth) return;
    const k = Math.min((stage.clientWidth - 16) / w, (stage.clientHeight - 16) / h);
    this.canvas.style.width = `${Math.max(1, Math.floor(w * k))}px`;
    this.canvas.style.height = `${Math.max(1, Math.floor(h * k))}px`;
  }

  open(source, aiMask = null) {
    this.src = source;
    const n = source.width * source.height;
    this.mask = new Uint8ClampedArray(n);
    for (let p = 0; p < n; p++) this.mask[p] = source.data[p * 4 + 3];
    this.aiMask = aiMask ?? this.mask.slice();   // „Od nowa” wraca do maski od AI
    this.undoStack = [];
    this.el.undo.disabled = true;
    this.canvas.width = source.width;
    this.canvas.height = source.height;
    this.view = new ImageData(source.width, source.height);
    this.#render();
    this.dialog.showModal();
    this.#fit();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  #close(result) {
    this.painting = false;
    this.dialog.close();
    this.resolve?.(result);
    this.resolve = null;
  }

  #result() {
    const out = new ImageData(new Uint8ClampedArray(this.src.data), this.src.width, this.src.height);
    for (let p = 0; p < this.mask.length; p++) out.data[p * 4 + 3] = this.mask[p];
    return out;
  }

  /** Obiekt normalnie; usunięte tło przyciemnione i zabarwione na czerwono – od razu widać, co wypadnie. */
  #render() {
    const s = this.src.data, d = this.view.data, m = this.mask;
    for (let p = 0, i = 0; p < m.length; p++, i += 4) {
      const a = m[p] / 255, b = 1 - a;
      d[i] = s[i] * a + (s[i] * 0.3 + 150) * b;
      d[i + 1] = s[i + 1] * a + (s[i + 1] * 0.3 + 20) * b;
      d[i + 2] = s[i + 2] * a + (s[i + 2] * 0.3 + 50) * b;
      d[i + 3] = 255;
    }
    this.ctx.putImageData(this.view, 0, 0);
  }

  #toImage(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k, r };
  }

  #showCursor(e) {
    const size = Number(this.el.brush.value);
    const box = this.canvas.parentElement.getBoundingClientRect();
    Object.assign(this.cursor.style, {
      width: `${size}px`, height: `${size}px`,
      left: `${e.clientX - box.left - size / 2}px`, top: `${e.clientY - box.top - size / 2}px`,
    });
    this.cursor.hidden = false;
    this.cursor.classList.toggle('remove', this.el.tool.value === 'remove');
  }

  #stamp(x, y, radius) {
    const { width: w, height: h } = this.src;
    const value = this.el.tool.value === 'remove' ? 0 : 255;
    const r2 = radius * radius;
    for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(h - 1, Math.ceil(y + radius)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(w - 1, Math.ceil(x + radius)); xx++) {
        const dx = xx - x, dy = yy - y;
        if (dx * dx + dy * dy <= r2) this.mask[yy * w + xx] = value;
      }
    }
  }

  #paintTo(e) {
    const { x, y, k } = this.#toImage(e);
    const radius = (Number(this.el.brush.value) / 2) * k;   // rozmiar pędzla podany w pikselach ekranu
    const from = this.last ?? { x, y };
    const dist = Math.hypot(x - from.x, y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 2)));
    for (let i = 1; i <= steps; i++) this.#stamp(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps, radius);
    this.last = { x, y };
    if (!this.frameQueued) {
      this.frameQueued = true;
      requestAnimationFrame(() => { this.frameQueued = false; this.#render(); });
    }
  }

  #pushUndo() {
    this.undoStack.push(this.mask.slice());
    if (this.undoStack.length > 25) this.undoStack.shift();
    this.el.undo.disabled = false;
  }

  #undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.mask.set(prev);
    this.el.undo.disabled = !this.undoStack.length;
    this.#render();
  }

  #down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.#pushUndo();
    this.painting = true;
    this.last = null;
    this.#paintTo(e);
  }

  #move(e) {
    this.#showCursor(e);
    if (this.painting) this.#paintTo(e);
  }

  #up() {
    this.painting = false;
    this.last = null;
  }
}
