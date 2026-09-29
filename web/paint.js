// S11: przemalowanie fragmentu modelu 3D (lokalnie, bez AI). Modele mają kolory wierzchołków (COLOR_0), więc „zmiana
// koloru spodni” = wybór spójnego obszaru siatki o podobnym kolorze (rozlewanie od klikniętego trójkąta po sąsiednich
// wierzchołkach) i przebarwienie go z zachowaniem cieniowania (nowy kolor × jasność względem średniej obszaru).
import * as THREE from 'three';

const _adjacency = new WeakMap();   // geometria → { neighbours: Array<Int32Array>, groups: Map(klucz pozycji → [wierzchołki]) }

/** Sąsiedztwo wierzchołków po trójkątach; wierzchołki o tej samej pozycji (rozcięte szwy, siatki bez indeksu) łączymy. */
function adjacency(geometry) {
  let adj = _adjacency.get(geometry);
  if (adj) return adj;
  const pos = geometry.attributes.position;
  const n = pos.count;
  const key = (i) => `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
  const groups = new Map();
  const groupOf = new Int32Array(n);
  const rep = [];
  for (let i = 0; i < n; i++) {
    const k = key(i);
    let g = groups.get(k);
    if (g === undefined) { g = rep.length; groups.set(k, g); rep.push([]); }
    rep[g].push(i);
    groupOf[i] = g;
  }
  const sets = rep.map(() => new Set());
  const index = geometry.index;
  const tri = index ? index.count / 3 : n / 3;
  const at = (t, c) => (index ? index.getX(t * 3 + c) : t * 3 + c);
  for (let t = 0; t < tri; t++) {
    const a = groupOf[at(t, 0)], b = groupOf[at(t, 1)], c = groupOf[at(t, 2)];
    sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
  }
  adj = { groupOf, members: rep, neighbours: sets.map((s) => Int32Array.from(s)) };
  _adjacency.set(geometry, adj);
  return adj;
}

/** Trafienie raycastera → wierzchołki obszaru: rozlewanie od trójkąta po sąsiadach o kolorze bliskim koloru ziarna.
 *  tolerance 0–1 (odległość w RGB względem √3). Zwraca { indices: Int32Array, seed: [r,g,b] } albo null (model bez kolorów). */
export function regionFromHit(mesh, faceIndex, tolerance) {
  const geometry = mesh.geometry;
  const color = geometry.attributes.color;
  if (!color) return null;
  const adj = adjacency(geometry);
  const index = geometry.index;
  const corners = [0, 1, 2].map((c) => (index ? index.getX(faceIndex * 3 + c) : faceIndex * 3 + c));
  const seed = [0, 1, 2].map((ch) => corners.reduce((s, v) => s + color.getComponent(v, ch), 0) / 3);
  const groupColor = (g) => {
    const m = adj.members[g];
    return [0, 1, 2].map((ch) => m.reduce((s, v) => s + color.getComponent(v, ch), 0) / m.length);
  };
  const limit = tolerance * Math.sqrt(3);
  const near = (c) => Math.hypot(c[0] - seed[0], c[1] - seed[1], c[2] - seed[2]) <= limit;
  const visited = new Uint8Array(adj.members.length);
  const queue = [];
  for (const v of corners) {
    const g = adj.groupOf[v];
    if (!visited[g]) { visited[g] = 1; queue.push(g); }
  }
  const out = [];
  while (queue.length) {
    const g = queue.pop();
    out.push(...adj.members[g]);
    for (const nb of adj.neighbours[g]) {
      if (!visited[nb] && near(groupColor(nb))) { visited[nb] = 1; queue.push(nb); }
    }
  }
  return { indices: Int32Array.from(out), seed };
}

/** Przebarwienie obszaru: cieniowanie zostaje (kolor wierzchołka / średnia obszaru), barwa = target. Zwraca stare kolory (do cofnięcia). */
export function recolor(mesh, indices, target) {
  const color = mesh.geometry.attributes.color;
  const old = new Float32Array(indices.length * 3);
  const mean = [0, 0, 0];
  for (let k = 0; k < indices.length; k++) {
    for (let ch = 0; ch < 3; ch++) { const v = color.getComponent(indices[k], ch); old[k * 3 + ch] = v; mean[ch] += v; }
  }
  for (let ch = 0; ch < 3; ch++) mean[ch] = Math.max(0.02, mean[ch] / indices.length);
  const meanLum = 0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2];
  for (let k = 0; k < indices.length; k++) {
    // jasność względna liczona z luminancji (nie po kanałach) – przemalowanie szarego na czerwony nie robi się różowe
    const lum = 0.299 * old[k * 3] + 0.587 * old[k * 3 + 1] + 0.114 * old[k * 3 + 2];
    const f = Math.min(1.6, lum / meanLum);
    for (let ch = 0; ch < 3; ch++) color.setComponent(indices[k], ch, THREE.MathUtils.clamp(target[ch] * f, 0, 1));
  }
  color.needsUpdate = true;
  return old;
}

export function restoreColors(mesh, indices, old) {
  const color = mesh.geometry.attributes.color;
  for (let k = 0; k < indices.length; k++) for (let ch = 0; ch < 3; ch++) color.setComponent(indices[k], ch, old[k * 3 + ch]);
  color.needsUpdate = true;
}

/** '#rrggbb' → [r,g,b] w 0–1 (przestrzeń kolorów: kolory wierzchołków idą 1:1, patrz CLAUDE.md „Kolory”). */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
