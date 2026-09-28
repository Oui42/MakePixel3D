// Silnik pixel-artu: render widoku 3D w niskiej rozdzielczości + obróbka (paleta, dithering, kontur, przezroczystość).
// Kolejność: render z nadpróbkowaniem (S×S próbek na piksel) → uśrednienie albo kolor dominujący
// → dopasowanie kolorów do zdjęcia → korekta kolorów → paleta WSPÓLNA dla wszystkich kierunków
// (żeby obiekt nie „mienił się” przy obrocie) → dithering → samotne piksele → kontur.
import * as THREE from 'three';

const DEG = Math.PI / 180;

/** Kierunek kamery dla danego obrotu (yaw) i pochylenia (pitch). yaw 0 = przód obiektu. */
export function viewDirection(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG;
  const pitch = Math.min(pitchDeg, 89.9) * DEG;   // przy 90° lookAt traci orientację
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}

/** Światło kierunkowe „z lewej-góry-przodu” względem kamery (klasyczne dla sprite'ów). */
export function placeHeadlight(light, camera) {
  light.position.set(-1, 1.4, 1.2).applyQuaternion(camera.quaternion);
  light.target.position.set(0, 0, 0);
  light.target.updateMatrixWorld();
}

export class SpriteRenderer {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;  // kolory wierzchołków bez konwersji
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.camera.layers.set(0);   // warstwa 1 = pomocnicze obiekty podglądu (siatka, strzałka)
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** frame = { left, right, top, bottom } w jednostkach świata, względem punktu `target`. */
  placeCamera(yawDeg, pitchDeg, frame, target) {
    const cam = this.camera;
    cam.position.copy(viewDirection(yawDeg, pitchDeg).multiplyScalar(10)).add(target);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    Object.assign(cam, frame);
    cam.near = 0.01; cam.far = 20;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /**
   * Surowy render (w × h) jednego widoku.
   * `light` (opcjonalnie) ustawiamy względem kamery – w każdym kierunku światło pada z tej samej strony ekranu.
   */
  render(scene, yawDeg, pitchDeg, frame, target, w, h, light = null, layer = 0) {
    this.renderer.setSize(w, h, false);
    this.placeCamera(yawDeg, pitchDeg, frame, target);
    if (light) placeHeadlight(light, this.camera);
    this.camera.layers.set(layer);   // warstwa 2 = sam cień (osobny przebieg)
    this.renderer.render(scene, this.camera);
    this.camera.layers.set(0);
    this.canvas.width = w; this.canvas.height = h;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(this.renderer.domElement, 0, 0);
    return this.ctx.getImageData(0, 0, w, h);
  }

  /**
   * Zasięg obiektu na ekranie (względem `target`) – maksimum po wszystkich kierunkach,
   * dzięki czemu skala i położenie są takie same we wszystkich sprite'ach.
   */
  measure(points, yaws, pitchDeg, target) {
    let maxU = 1e-6, minV = 0, maxV = 1e-6;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
    const unit = { left: -1, right: 1, top: 1, bottom: -1 };
    for (const yaw of yaws) {
      this.placeCamera(yaw, pitchDeg, unit, target);
      this.camera.matrixWorld.extractBasis(right, up, fwd);
      for (let i = 0; i < points.length; i += 3) {
        const x = points[i] - target.x, y = points[i + 1] - target.y, z = points[i + 2] - target.z;
        const u = x * right.x + y * right.y + z * right.z;
        const v = x * up.x + y * up.y + z * up.z;
        if (Math.abs(u) > maxU) maxU = Math.abs(u);
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    return { maxU, minV, maxV };
  }
}

/**
 * Kadr kamery dla sprite'a W×H (w pikselach docelowych).
 * anchor 'center' – obiekt na środku; 'ground' – punkt podłoża zawsze w tym samym wierszu przy dolnej krawędzi.
 */
export function computeFrame(m, W, H, pad, zoom, anchor) {
  const availW = Math.max(1, W - 2 * pad), availH = Math.max(1, H - 2 * pad);
  if (anchor === 'ground') {
    const wpp = Math.max((2 * m.maxU) / availW, (m.maxV - m.minV) / availH) / zoom;
    const bottom = m.minV - pad * wpp;
    return { left: (-W / 2) * wpp, right: (W / 2) * wpp, bottom, top: bottom + H * wpp };
  }
  const maxV = Math.max(m.maxV, -m.minV);
  const wpp = Math.max((2 * m.maxU) / availW, (2 * maxV) / availH) / zoom;
  return { left: (-W / 2) * wpp, right: (W / 2) * wpp, bottom: (-H / 2) * wpp, top: (H / 2) * wpp };
}

/** Obraz 2D (wycięty obiekt) wpasowany w w × h – tryb bez modelu 3D. */
export function rasterizeImage(img, w, h, pad = 0, zoom = 1, anchor = 'center') {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const s = Math.min((w - 2 * pad) / img.width, (h - 2 * pad) / img.height) * zoom;
  const dw = img.width * s, dh = img.height * s;
  const y = anchor === 'ground' ? h - pad - dh : (h - dh) / 2;
  ctx.drawImage(img, (w - dw) / 2, y, dw, dh);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Bloki S×S → W×H. Piksel jest pełny, gdy pokrycie ≥ próg (reszta w pełni przezroczysta).
 * sharp = true: kolor dominujący w bloku (ostrzejsze detale), inaczej średnia (gładsze przejścia).
 */
function downsample(raw, W, H, S, threshold, sharp) {
  const rgb = new Float32Array(W * H * 3);
  const mask = new Uint8Array(W * H);
  const d = raw.data, RW = raw.width, full = 255 * S * S;
  const keys = new Int32Array(S * S), cnt = new Int32Array(S * S);
  const sr = new Float32Array(S * S), sg = new Float32Array(S * S), sb = new Float32Array(S * S);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0, buckets = 0;
      for (let sy = 0; sy < S; sy++) {
        let i = ((y * S + sy) * RW + x * S) * 4;
        for (let sx = 0; sx < S; sx++, i += 4) {
          const al = d[i + 3];
          if (!al) continue;
          r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
          if (sharp && al >= 128) {
            // grupujemy próbki po zgrubnym kolorze (4 bity na kanał) i liczymy, która grupa wygrywa
            const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
            let k = 0;
            while (k < buckets && keys[k] !== key) k++;
            if (k === buckets) { keys[k] = key; cnt[k] = 0; sr[k] = sg[k] = sb[k] = 0; buckets++; }
            cnt[k]++; sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
          }
        }
      }
      const o = y * W + x;
      if (a > 0 && a / full >= threshold) {
        mask[o] = 1;
        if (buckets) {
          let best = 0;
          for (let k = 1; k < buckets; k++) if (cnt[k] > cnt[best]) best = k;
          rgb[o * 3] = sr[best] / cnt[best]; rgb[o * 3 + 1] = sg[best] / cnt[best]; rgb[o * 3 + 2] = sb[best] / cnt[best];
        } else {
          rgb[o * 3] = r / a; rgb[o * 3 + 1] = g / a; rgb[o * 3 + 2] = b / a;
        }
      }
    }
  }
  return { rgb, mask, W, H };
}

/** Sama maska pokrycia (bez kolorów) – do cienia pod obiektem. */
function coverageMask(raw, W, H, S) {
  const mask = new Uint8Array(W * H);
  const d = raw.data, RW = raw.width, half = (S * S) / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0;
    for (let sy = 0; sy < S; sy++) {
      let i = ((y * S + sy) * RW + x * S) * 4 + 3;
      for (let sx = 0; sx < S; sx++, i += 4) if (d[i] > 127) n++;
    }
    if (n >= half) mask[y * W + x] = 1;
  }
  return mask;
}

/** Średnia i odchylenie każdego kanału RGB dla pikseli nieprzezroczystych (alfa > 200). */
export function colorStats(imageData) {
  const d = imageData.data, sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= 200) continue;
    for (let c = 0; c < 3; c++) { sum[c] += d[i + c]; sq[c] += d[i + c] * d[i + c]; }
    n++;
  }
  if (!n) return null;
  const mean = sum.map((s) => s / n);
  return { mean, std: sq.map((s, c) => Math.sqrt(Math.max(1, s / n - mean[c] ** 2))) };
}

/** Przesuwa kolory wszystkich widoków tak, by średnia i rozrzut pasowały do zdjęcia (model AI bywa ciemniejszy). */
function matchColors(views, ref) {
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  for (const { rgb, mask } of views) for (let o = 0; o < mask.length; o++) {
    if (!mask[o]) continue;
    for (let c = 0; c < 3; c++) { const v = rgb[o * 3 + c]; sum[c] += v; sq[c] += v * v; }
    n++;
  }
  if (!n) return;
  const gain = [], mean = sum.map((s) => s / n);
  for (let c = 0; c < 3; c++) {
    const std = Math.sqrt(Math.max(1, sq[c] / n - mean[c] ** 2));
    gain[c] = Math.max(0.5, Math.min(2, ref.std[c] / std));
  }
  for (const { rgb, mask } of views) for (let o = 0; o < mask.length; o++) {
    if (!mask[o]) continue;
    for (let c = 0; c < 3; c++) {
      const k = o * 3 + c;
      rgb[k] = Math.max(0, Math.min(255, (rgb[k] - mean[c]) * gain[c] + ref.mean[c]));
    }
  }
}

function adjustColors(v, sat, contrast, bright) {
  const { rgb, mask } = v;
  for (let o = 0; o < mask.length; o++) {
    if (!mask[o]) continue;
    const k = o * 3;
    const gray = 0.299 * rgb[k] + 0.587 * rgb[k + 1] + 0.114 * rgb[k + 2];
    for (let c = 0; c < 3; c++) {
      let val = gray + (rgb[k + c] - gray) * sat;
      val = (val - 128) * contrast + 128 + bright;
      rgb[k + c] = Math.max(0, Math.min(255, val));
    }
  }
}

/** Paleta metodą median cut – dzieli przestrzeń kolorów na `k` pudełek i bierze ich średnie. */
export function medianCut(px, k) {
  const n = px.length / 3;
  if (n === 0) return [];
  const boxes = [Array.from({ length: n }, (_, i) => i)];
  const range = (ids) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const i of ids) for (let c = 0; c < 3; c++) {
      const v = px[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
    }
    const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
    return { ch, size: r[ch] };
  };
  while (boxes.length < k) {
    let best = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((ids, bi) => {
      if (ids.length < 2) return;
      const { ch, size } = range(ids);
      const score = size * Math.sqrt(ids.length);
      if (score > bestScore) { bestScore = score; best = bi; bestCh = ch; }
    });
    if (best < 0) break;
    const ids = boxes[best].sort((a, b) => px[a * 3 + bestCh] - px[b * 3 + bestCh]);
    const mid = ids.length >> 1;
    boxes.splice(best, 1, ids.slice(0, mid), ids.slice(mid));
  }
  return boxes.map((ids) => {
    let r = 0, g = 0, b = 0;
    for (const i of ids) { r += px[i * 3]; g += px[i * 3 + 1]; b += px[i * 3 + 2]; }
    return [Math.round(r / ids.length), Math.round(g / ids.length), Math.round(b / ids.length)];
  });
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Najbliższy kolor palety (odległość ważona – oko jest najczulsze na zieleń). */
export function nearestFn(palette) {
  const cache = new Map();
  return (r, g, b) => {
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));
    const key = (r << 16) | (g << 8) | b;
    let best = cache.get(key);
    if (best) return best;
    let bd = Infinity;
    for (const p of palette) {
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const dist = 3 * dr * dr + 4 * dg * dg + 2 * db * db;
      if (dist < bd) { bd = dist; best = p; }
    }
    cache.set(key, best);
    return best;
  };
}

/**
 * Mapowanie po jasności (Game Boy, szarości, 1-bit): zakres jasności obrazu [lo, hi]
 * rozciągamy na zakres jasności palety – dzięki temu ciemne zdjęcie nie „zlewa się” w jeden kolor.
 */
function lumaFn(palette, lo, hi) {
  const sorted = [...palette].sort((a, b) => luma(...a) - luma(...b));
  const pl = sorted.map((p) => luma(...p));
  const pLo = pl[0], pHi = pl[pl.length - 1], span = Math.max(1, hi - lo);
  return (r, g, b) => {
    const target = pLo + ((luma(r, g, b) - lo) / span) * (pHi - pLo);
    let best = 0;
    for (let i = 1; i < pl.length; i++) if (Math.abs(pl[i] - target) < Math.abs(pl[best] - target)) best = i;
    return sorted[best];
  };
}

// Macierz Bayera 4×4 – uporządkowany dithering (stały wzór = brak „migotania” między klatkami)
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Usuwa samotne piksele (bez żadnego sąsiada, także po skosie). */
function removeOrphans(mask, W, H) {
  const out = mask.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * W + x;
    if (!mask[o]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) nb++;
    }
    if (nb === 0) out[o] = 0;
  }
  return out;
}

function compose(v, mapper, spread, o, shadow) {
  const { W, H } = v;
  const img = new ImageData(W, H);
  const d = img.data;
  const mask = o.removeOrphans ? removeOrphans(v.mask, W, H) : v.mask;
  const dither = mapper ? o.dither * spread : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!mask[i]) continue;
    let r = v.rgb[i * 3], g = v.rgb[i * 3 + 1], b = v.rgb[i * 3 + 2];
    if (mapper) {
      const off = dither ? (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5 + 1 / 32) * dither : 0;
      [r, g, b] = mapper(r + off, g + off, b + off);
    }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  // cień: tylko tam, gdzie nie ma obiektu (obiekt go zasłania); kontur niżej i tak go nadpisze przy krawędzi
  if (shadow) {
    for (let i = 0; i < W * H; i++) if (!mask[i] && shadow.mask[i]) d.set(shadow.color, i * 4);
  }
  if (o.outline !== 'none') {
    const src = new Uint8ClampedArray(d);  // kolory przed dodaniem konturu
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i]) continue;
      let nb = -1;
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) { nb = yy * W + xx; break; }
      }
      if (nb < 0) continue;
      let c;
      if (o.outline === 'color') c = o.outlineColor;
      else {
        c = [src[nb * 4] * 0.35, src[nb * 4 + 1] * 0.35, src[nb * 4 + 2] * 0.35];  // przyciemniony sąsiad
        if (o.fixedPalette) c = o.fixedPalette.luma ? o.fixedPalette.darkest : mapper(...c);  // kontur też z palety
      }
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
    }
  }
  return img;
}

/**
 * Surowe rendery (W*S × H*S) → gotowe sprite'y W×H ze wspólną paletą.
 * o: { threshold, sharp, saturation, contrast, brightness, colors (0 = bez limitu),
 *      fixedPalette ({ colors, luma } albo null), dither (0–1), removeOrphans, outline, outlineColor,
 *      reference (colorStats zdjęcia albo null), shadow (widoczność cienia 0–1; 0 = bez cienia),
 *      shadowColor ('palette' = najciemniejszy kolor palety albo [r, g, b]) }
 * shadowRaws – rendery samego cienia (warstwa 2) dla tych samych widoków albo null.
 */
export function pixelizeViews(raws, W, H, S, o, shadowRaws = null) {
  const views = raws.map((r) => downsample(r, W, H, S, o.threshold, o.sharp));
  if (o.reference) matchColors(views, o.reference);
  views.forEach((v) => adjustColors(v, o.saturation, o.contrast, o.brightness));

  let palette = [], mapper = null;
  const fixed = o.fixedPalette;
  if (fixed || o.colors > 0) {
    const samples = [];
    for (const v of views) for (let i = 0; i < v.mask.length; i++) {
      if (v.mask[i]) samples.push(v.rgb[i * 3], v.rgb[i * 3 + 1], v.rgb[i * 3 + 2]);
    }
    if (fixed) {
      palette = fixed.colors;
      if (fixed.luma) {
        // zakres jasności obrazu: 2.–98. percentyl (odporne na pojedyncze skrajne piksele)
        const L = [];
        for (let i = 0; i < samples.length; i += 3) L.push(luma(samples[i], samples[i + 1], samples[i + 2]));
        L.sort((a, b) => a - b);
        const lo = L.length ? L[Math.floor(L.length * 0.02)] : 0, hi = L.length ? L[Math.floor(L.length * 0.98)] : 255;
        mapper = lumaFn(palette, lo, hi);
        fixed.darkest = [...palette].sort((a, b) => luma(...a) - luma(...b))[0];
      } else {
        mapper = nearestFn(palette);
      }
    } else {
      palette = medianCut(samples, o.colors);
      if (palette.length) mapper = nearestFn(palette);
    }
  }
  // siła ditheringu zależy od tego, jak „gęsta” jest paleta
  const spread = palette.length ? 255 / Math.max(1.5, Math.cbrt(palette.length)) : 0;

  // cień: kolor z ustawień (najciemniejszy z palety / czarny / własny); widoczność = alfa
  // (100% = pełny, piksele dalej 0/255; mniej = półprzezroczysty)
  let shadowColor = null;
  if (shadowRaws && o.shadow > 0) {
    const rgb = Array.isArray(o.shadowColor)
      ? o.shadowColor
      : (palette.length ? [...palette].sort((a, b) => luma(...a) - luma(...b))[0] : [22, 18, 30]);
    shadowColor = [...rgb, Math.round(255 * Math.min(1, o.shadow))];
  }
  const sprites = views.map((v, i) => compose(v, mapper, spread, o,
    shadowColor ? { mask: coverageMask(shadowRaws[i], W, H, S), color: shadowColor } : null));
  return { sprites, palette };
}

/** ImageData → canvas powiększony „twardo” (bez wygładzania) o całkowitą skalę. */
export function spriteCanvas(img, scale = 1) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  if (scale === 1) return c;
  const big = document.createElement('canvas');
  big.width = img.width * scale; big.height = img.height * scale;
  const ctx = big.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, 0, 0, big.width, big.height);
  return big;
}
