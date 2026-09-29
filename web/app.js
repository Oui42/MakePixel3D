// MakePixel3D – interfejs: wczytanie zdjęcia, model 3D (z serwera), podgląd, pixel-art, eksport.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SpriteRenderer, pixelizeViews, rasterizeImage, spriteCanvas, viewDirection, placeHeadlight,
  colorStats, computeFrame, medianCut, nearestFn,
} from './pixel.js';
import { PALETTES, parsePaletteText, paletteFromImage } from './palettes.js';
import { buildSymmetricGeometry } from './symmetry.js';
import { voxelize, buildVoxelMesh, voxelMaterial, voxelFitPoints } from './voxels.js';
import { PRESETS, SAVED_FIELDS, loadSaved, save, clearSaved, loadCustomPalette, saveCustomPalette } from './presets.js';
import { initSegmented, syncShortcutButtons } from './segmented.js';
import { t, getLang, setLang, locale, translateDom } from './i18n.js';
import { imageDataFromBlob, imageDataToBlob, cropToObject, MaskEditor } from './mask.js';
import { PixelEditor } from './editor.js';
import { findRig, resetPose, clipNames, buildClip, setArmsDown, CLIP_LABELS } from './rig.js';
import {
  listEntries, fetchFile, renameEntry, deleteEntry, renderTiles, createEntry, saveProject, fetchProject,
} from './gallery.js';

const $ = (id) => document.getElementById(id);
initSegmented();   // listy <select data-seg> → przyciski wyboru (przed wczytaniem zapamiętanych ustawień)
const MAX_RAW = 768;          // maks. bok surowego renderu (rozmiar × nadpróbkowanie)
const MAX_FIT_POINTS = 40000; // tyle wierzchołków wystarczy do policzenia kadru

const state = {
  baseName: 'sprite',
  source: null,       // CAŁE zdjęcie (ImageData) z maską obiektu w alfie – do ręcznej poprawki tła
  sourceBlob: null,   // to samo jako PNG (trafia do galerii)
  aiMask: null,       // maska od AI – „Od nowa” w poprawce tła
  photoId: 0,         // rośnie przy każdej zmianie wycięcia (klucz poprawek pikseli w trybie 2D)
  modelId: 0,         // rośnie przy każdym wczytaniu modelu (klucz poprawek pikseli)
  libraryId: null,    // wpis w galerii dla bieżącego modelu
  dirty: false,       // są zmiany niezapisane w galerii
  savedAt: null,      // kiedy ostatnio zapisano w galerii (w tej sesji)
  cutoutBlob: null,   // obiekt bez tła, przycięty (PNG) – wejście modelu 3D
  cutoutImg: null,
  refStats: null,     // statystyki kolorów zdjęcia (do dopasowania kolorów modelu)
  glbBlob: null,
  model: null,        // THREE.Object3D z wczytanego GLB
  meshes: [],         // siatki modelu
  symMesh: null,      // siatka symetryczna (gdy symetria włączona – zamiast modelu)
  voxel: null,        // model z wokseli (InstancedMesh) – gdy włączony, zastępuje model/symetrię
  voxelData: null,
  rig: null,          // S10: szkielet w modelu (rig.js findRig) – null, gdy model bez kości
  mixer: null,        // THREE.AnimationMixer dla klipów proceduralnych
  action: null,       // aktywny klip (null = bez animacji, poza spoczynkowa)
  customPalette: loadCustomPalette(),
  dirIndex: 0,
  sprites: [],
  yaws: [],
};

// Animacja obrotu (osobne, gęstsze klatki – te same co w eksporcie GIF)
const anim = { frames: [], index: 0, timer: 0, buildTimer: 0, paused: false };

// ---------- Scena: pivot (obrót „przodu”) → tilt (przewrócenie) → norm (środek i skala) → model ----------
const scene = new THREE.Scene();
const pivot = new THREE.Group();
const tilt = new THREE.Group();
const norm = new THREE.Group();
scene.add(pivot); pivot.add(tilt); tilt.add(norm);

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
scene.add(ambient, sun, sun.target);

// Obiekty pomocnicze tylko w podglądzie 3D (warstwa 1 – nie trafiają do sprite'ów)
const grid = new THREE.GridHelper(2.4, 12, 0x8a7fb0, 0x4a4460);
const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.45, 0x9b78ff, 0.14, 0.09);
for (const o of [grid, arrow]) { o.traverse((c) => c.layers.set(1)); scene.add(o); }
grid.visible = arrow.visible = false;

// Cień pod obiektem: płaska elipsa na podłożu, tylko na warstwie 2 (osobny przebieg renderu sprite'a)
const shadowDisk = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
);
shadowDisk.layers.set(2);
scene.add(shadowDisk);

const viewer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
viewer.outputColorSpace = THREE.LinearSRGBColorSpace;
$('viewer').appendChild(viewer.domElement);
const viewCam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
viewCam.layers.enable(1);
viewCam.position.set(1.6, 1.2, 3.2);
const controls = new OrbitControls(viewCam, viewer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.2; controls.maxDistance = 10;
new ResizeObserver(([e]) => {
  const { width, height } = e.contentRect;
  viewer.setSize(width, height, false);
  viewCam.aspect = width / Math.max(1, height);
  viewCam.updateProjectionMatrix();
}).observe($('viewer'));
const viewClock = new THREE.Clock();
viewer.setAnimationLoop(() => {
  controls.update();
  placeHeadlight(sun, viewCam);
  // S10: podgląd 3D gra wybraną animację na żywo (sprite'y renderują własną klatkę – applyClipPose w renderSprites)
  if (state.mixer && state.action && !anim.paused) state.mixer.update(viewClock.getDelta());
  else viewClock.getDelta();
  viewer.render(scene, viewCam);
});

const sprite = new SpriteRenderer();

// ---------- Ustawienia z formularza ----------
const num = (id) => Number($(id).value);
const OUTPUTS = {
  pitch: (v) => `${v}°`, zoom: (v) => `${v}%`, baseYaw: (v) => `${v}°`, voxelRes: (v) => t('{v} na bok', { v }),
  colors: (v) => (+v === 0 ? t('bez limitu') : v), dither: (v) => (+v === 0 ? t('wył.') : `${v}%`),
  saturation: (v) => `${v}%`, contrast: (v) => `${v}%`,
  brightness: (v) => (v > 0 ? `+${v}` : v), threshold: (v) => `${v}%`,
  shadowOpacity: (v) => (+v === 0 ? t('wył.') : `${v}%`),
};
/** Odświeża wszystko, co zależy od wartości pól: podpisy suwaków, skróty pochylenia, kolor konturu. */
function updateOutputs() {
  for (const [id, fmt] of Object.entries(OUTPUTS)) $(`${id}Out`).textContent = fmt($(id).value);
  syncShortcutButtons(document.querySelector('.presets[data-target="pitch"]'), $('pitch').value);
  $('outlineColorRow').hidden = $('outline').value !== 'color';   // kolor ma sens tylko przy „jednolity kolor”
  // kolor cienia – tylko gdy cień jest włączony; pole koloru tylko przy „Własny”
  $('shadowColorModeRow').hidden = num('shadowOpacity') === 0;
  $('shadowColorRow').hidden = num('shadowOpacity') === 0 || $('shadowColorMode').value !== 'custom';
  $('voxelResRow').hidden = $('voxelMode').value !== 'on';
}

/** Liczebniki: po polsku 1 kolor, 2–4 kolory, 5+ kolorów (ale 12–14 kolorów); po angielsku 1 colour / n colours. */
function plural(n, one, few, many, enOne, enMany) {
  if (getLang() !== 'pl') return `${n} ${n === 1 ? enOne : enMany}`;
  if (n === 1) return `1 ${one}`;
  const d = n % 10, h = n % 100;
  return `${n} ${d >= 2 && d <= 4 && !(h >= 12 && h <= 14) ? few : many}`;
}
const colorsWord = (n) => plural(n, 'kolor', 'kolory', 'kolorów', 'colour', 'colours');
const framesWord = (n) => plural(n, 'klatka', 'klatki', 'klatek', 'frame', 'frames');

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Stała paleta ({ name, colors, luma }) albo null, gdy paleta ma powstać automatycznie z obrazu. */
function currentPalette() {
  const mode = $('paletteMode').value;
  if (mode === 'auto') return null;
  if (mode === 'custom') return state.customPalette;
  return PALETTES[mode] ?? null;
}

function options() {
  return {
    threshold: num('threshold') / 100,
    sharp: $('sampling').value === 'sharp',
    saturation: num('saturation') / 100,
    contrast: num('contrast') / 100,
    brightness: num('brightness'),
    colors: num('colors'),
    fixedPalette: currentPalette(),
    dither: num('dither') / 100,
    removeOrphans: $('removeOrphans').checked,
    outline: $('outline').value,
    outlineColor: hexToRgb($('outlineColor').value),
    reference: state.model && $('matchPhoto').checked ? state.refStats : null,
    shadow: state.model ? num('shadowOpacity') / 100 : 0,
    shadowColor: { palette: 'palette', black: [0, 0, 0] }[$('shadowColorMode').value] ?? hexToRgb($('shadowColor').value),
  };
}

function spriteSize() {
  const W = num('size');
  return { W, H: Math.max(1, Math.round(W * Number($('aspect').value))) };
}

function directions() {
  const n = state.model ? num('dirCount') : 1;
  return Array.from({ length: n }, (_, i) => (i * 360) / n);
}

function dirLabel(yaw) {
  const names = { 0: t('przód'), 90: t('bok'), 180: t('tył'), 270: t('bok') };
  const r = Math.round(yaw * 10) / 10;
  return names[r] ? `${r}° ${names[r]}` : `${r}°`;
}

/** Włącza/wyłącza pola zależne od wybranej palety. */
function updatePaletteUi() {
  const mode = $('paletteMode').value;
  const fixed = currentPalette();
  $('colors').disabled = !!fixed;
  $('customPaletteRow').hidden = mode !== 'custom';
  $('dither').disabled = !fixed && num('colors') === 0;
  let info = '';
  if (mode === 'custom') {
    info = state.customPalette
      ? t('Wczytano: {name} ({count})', { name: state.customPalette.name, count: colorsWord(state.customPalette.colors.length) })
      : t('Wybierz plik palety – np. z lospec.com (format .hex).');
  } else if (fixed) {
    info = `${colorsWord(fixed.colors.length)}${fixed.luma ? t(' – mapowanie po jasności') : ''}`;
  }
  $('paletteInfo').textContent = info;
}

// ---------- Materiały: kolory wierzchołków / tekstura, płasko albo z cieniowaniem ----------
function makeMaterial(orig, geometry, lit) {
  const hasColors = !!geometry.attributes.color;
  const map = orig?.map ?? null;
  if (map) { map.colorSpace = THREE.NoColorSpace; map.magFilter = THREE.NearestFilter; map.needsUpdate = true; }
  if (lit && !geometry.attributes.normal) geometry.computeVertexNormals();
  const Mat = lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial;
  return new Mat({
    vertexColors: hasColors, map,
    color: hasColors || map ? 0xffffff : (orig?.color ?? new THREE.Color(0xcccccc)),
    side: THREE.DoubleSide,
  });
}

function applyMaterials() {
  const lit = $('lighting').value === 'lit';
  for (const m of state.meshes) {
    const orig = m.userData.origMaterial ?? (m.userData.origMaterial = m.material);
    if (m.material !== orig) m.material.dispose();
    m.material = makeMaterial(orig, m.geometry, lit);
  }
  if (state.symMesh) {
    state.symMesh.material?.dispose();
    state.symMesh.material = makeMaterial(state.meshes[0]?.userData.origMaterial, state.symMesh.geometry, lit);
  }
  if (state.voxel) {
    state.voxel.material.dispose();
    state.voxel.material = voxelMaterial(lit);
  }
}

// ---------- Woksele ----------
/** Przebudowa modelu z wokseli z aktywnej bryły (model albo wersja symetryczna); wyłączone = sprzątanie. */
function updateVoxels() {
  if (state.voxel) {
    scene.remove(state.voxel);
    state.voxel.material.dispose();
    state.voxel.dispose();
    state.voxel = state.voxelData = null;
  }
  if (!state.model) return;
  // widoczność zwykłej bryły: symetria zastępuje model (updateSymmetry), woksele zastępują jedno i drugie
  if (state.symMesh) state.symMesh.visible = true;
  state.model.visible = !state.symMesh;
  if ($('voxelMode').value !== 'on') return;
  scene.updateMatrixWorld(true);
  const data = voxelize(state.symMesh ? [state.symMesh] : state.meshes, num('voxelRes'));
  if (!data) return;
  state.voxelData = data;
  state.voxel = buildVoxelMesh(data, voxelMaterial($('lighting').value === 'lit'));
  scene.add(state.voxel);
  state.model.visible = false;
  if (state.symMesh) state.symMesh.visible = false;
}

// ---------- Symetria ----------
function updateSymmetry() {
  if (state.symMesh) {
    scene.remove(state.symMesh);
    state.symMesh.geometry.dispose();
    state.symMesh.material?.dispose();
    state.symMesh = null;
  }
  if (!state.model) return;
  state.model.visible = true;
  const mode = $('symmetry').value;
  if (mode !== 'off') {
    scene.updateMatrixWorld(true);
    const geo = buildSymmetricGeometry(state.meshes, mode);
    if (geo) {
      state.symMesh = new THREE.Mesh(geo);
      scene.add(state.symMesh);
      state.model.visible = false;
    }
  }
  applyMaterials();
}

// ---------- Wczytanie modelu GLB ----------
async function loadGlb(buffer) {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  if (state.model) norm.remove(state.model);
  state.model = gltf.scene;
  norm.add(state.model);
  norm.position.set(0, 0, 0); norm.scale.setScalar(1);
  norm.updateMatrixWorld(true);

  // wyśrodkowanie i skala do promienia ≈ 1
  const box = new THREE.Box3().setFromObject(state.model);
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  norm.scale.setScalar(1 / radius);
  norm.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-1 / radius);

  state.meshes = [];
  state.model.traverse((o) => { if (o.isMesh) state.meshes.push(o); });
  state.modelId++;
  setupRig();   // S10: szkielet (jeśli GLB go ma) → klipy animacji

  grid.visible = arrow.visible = true;
  state.dirIndex = 0;
  setStage('model');
  updateOrientation();
}

/** Próbka punktów aktywnej siatki (model albo wersja symetryczna) w układzie świata. */
function fitPoints() {
  if (state.voxelData) return voxelFitPoints(state.voxelData, MAX_FIT_POINTS);
  scene.updateMatrixWorld(true);
  const meshes = state.symMesh ? [state.symMesh] : state.meshes;
  const total = meshes.reduce((s, m) => s + m.geometry.attributes.position.count, 0);
  const step = Math.max(1, Math.floor(total / MAX_FIT_POINTS));
  const out = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    const posed = m.isSkinnedMesh && state.action;   // S10: kadr liczony z pozy animacji, nie z pozy spoczynkowej
    if (posed) m.skeleton.update();
    for (let i = 0; i < pos.count; i += step) {
      if (posed) m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
      else v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  return out;
}

function minY(points) {
  let m = Infinity;
  for (let i = 1; i < points.length; i += 3) if (points[i] < m) m = points[i];
  return Number.isFinite(m) ? m : 0;
}

function updateOrientation() {
  pivot.rotation.y = THREE.MathUtils.degToRad(num('baseYaw'));
  scene.updateMatrixWorld(true);
  updateSymmetry();                   // płaszczyzna symetrii zależy od ustawienia „przodu”
  updateVoxels();                     // woksele są osiowe w układzie świata – po każdej zmianie ustawienia
  const pts = fitPoints();
  grid.position.y = minY(pts);        // podłoga siatki pod modelem
  fitShadow(pts);
  scheduleRefresh();
}

/** Elipsa cienia pod „stopami”: obrys dolnych 12% wysokości modelu, lekko powiększony. */
function fitShadow(pts) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < pts.length; i += 3) { lo = Math.min(lo, pts[i]); hi = Math.max(hi, pts[i]); }
  const limit = lo + (hi - lo) * 0.12;
  let x1 = Infinity, x2 = -Infinity, z1 = Infinity, z2 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] > limit) continue;
    x1 = Math.min(x1, pts[i]); x2 = Math.max(x2, pts[i]);
    z1 = Math.min(z1, pts[i + 2]); z2 = Math.max(z2, pts[i + 2]);
  }
  if (!Number.isFinite(x1)) return;
  const rx = Math.max(0.12, ((x2 - x1) / 2) * 1.25), rz = Math.max(0.1, ((z2 - z1) / 2) * 1.25);
  shadowDisk.position.set((x1 + x2) / 2, lo - 0.002, (z1 + z2) / 2);
  shadowDisk.scale.set(rx, 1, rz);
  shadowDisk.updateMatrixWorld();
}

/** Punkty obrzeża cienia – żeby kadr go nie uciął. */
function shadowRimPoints() {
  const out = [];
  const v = new THREE.Vector3();
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    v.set(Math.cos(a), 0, Math.sin(a)).applyMatrix4(shadowDisk.matrixWorld);
    out.push(v.x, v.y, v.z);
  }
  return out;
}

// ---------- Render pixel-artu ----------
let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  // w ukrytej karcie przeglądarka wstrzymuje requestAnimationFrame – wtedy liczymy od razu,
  // żeby po powrocie (np. po generowaniu w tle) podgląd był już gotowy
  const run = () => { refreshQueued = false; refresh(); };
  if (document.hidden) setTimeout(run, 0);
  else requestAnimationFrame(run);
}

/** Sprite'y dla podanych kierunków – wspólna paleta, skala i kadr. */
function renderSprites(yaws, poseTime = null) {
  const { W, H } = spriteSize();
  if (state.action) applyClipPose(poseTime ?? clipFrameTime());   // S10: sprite'y z wybranej klatki ruchu
  const S = Math.max(1, Math.min(8, Math.floor(MAX_RAW / Math.max(W, H))));
  const o = options();
  const pad = (o.outline !== 'none' ? 1 : 0) + 1;   // margines w pikselach (na kontur)
  const zoom = num('zoom') / 100;
  const anchor = $('anchor').value;
  let raws, shadowRaws = null;

  if (state.model) {
    const lit = $('lighting').value === 'lit';
    ambient.visible = sun.visible = lit;
    const pts = fitPoints();
    // „stopy na dole”: kamera celuje w punkt podłoża, który w każdym kierunku trafia w ten sam wiersz
    const target = anchor === 'ground' ? new THREE.Vector3(0, minY(pts), 0) : new THREE.Vector3();
    if (o.shadow > 0) pts.push(...shadowRimPoints());
    const pitch = num('pitch');
    const frame = computeFrame(sprite.measure(pts, yaws, pitch, target), W, H, pad, zoom, anchor);
    raws = yaws.map((y) => sprite.render(scene, y, pitch, frame, target, W * S, H * S, lit ? sun : null));
    if (o.shadow > 0) shadowRaws = yaws.map((y) => sprite.render(scene, y, pitch, frame, target, W * S, H * S, null, 2));
  } else {
    raws = [rasterizeImage(state.cutoutImg, W * S, H * S, pad * S, zoom, anchor)];
  }
  const result = pixelizeViews(raws, W, H, S, o, shadowRaws);
  applyEdits(result.sprites, yaws);
  return result;
}

// ---------- Poprawki pikseli (warstwy nakładane na render) ----------
// Klucz = wszystko, co przesuwa piksele (model/zdjęcie, rozmiar, kamera, obrót, symetria, margines) + kierunek.
// Kolory, paleta, dithering itp. nie wchodzą do klucza – dlatego poprawki przeżywają ich zmianę.
const edits = new Map();

function editSignature() {
  const { W, H } = spriteSize();
  const margins = `${$('outline').value !== 'none'}`;
  if (!state.model) return `2d:${state.photoId}|${W}x${H}|${num('zoom')}|${$('anchor').value}|${margins}`;
  const q = tilt.quaternion;
  return [`3d:${state.modelId}`, `${W}x${H}`, num('pitch'), num('zoom'), $('anchor').value, num('baseYaw'),
    [q.x, q.y, q.z, q.w].map((v) => v.toFixed(2)).join(','), $('symmetry').value, num('shadowOpacity') > 0, margins,
    $('voxelMode').value === 'on' ? `vox${num('voxelRes')}` : 'smooth',
    state.action ? `clip:${state.action.getClip().name}:${num('animFrame')}/${num('clipFrames')}` : 'rest'].join('|');
}

const editKey = (yaw, sig = editSignature()) => `${sig}|${yaw}`;

function applyEdits(sprites, yaws) {
  const sig = editSignature();
  sprites.forEach((img, i) => {
    const layer = edits.get(editKey(yaws[i], sig));
    if (layer) for (const [p, c] of layer) img.data.set(c, p * 4);
  });
}

const currentEditKey = () => (state.sprites.length ? editKey(state.yaws[state.dirIndex]) : null);

function applyEditValues(entry) {
  if (!entry) return;
  let layer = edits.get(entry.key);
  if (!layer) edits.set(entry.key, (layer = new Map()));
  for (const [p, v] of entry.values) {
    if (v === undefined) layer.delete(p);
    else layer.set(p, v);
  }
  refresh();
  updateEditButtons();
  markDirty();
}

const editor = new PixelEditor($('spriteView'), $('spriteOverlay'), {
  target() {
    const img = state.sprites[state.dirIndex];
    if (!img) return null;
    const key = currentEditKey();
    let layer = edits.get(key);
    if (!layer) edits.set(key, (layer = new Map()));
    return { img, layer, key };
  },
  color: () => hexToRgb($('editColor').value),
  onPaint() { $('spriteView').getContext('2d').putImageData(state.sprites[state.dirIndex], 0, 0); },
  onCommit() {
    markDirty();
    drawStrip();
    if (state.model && !animFollowsDirections()) scheduleAnimFrames();
    updateEditButtons();
  },
  onPick(color) {
    $('editColor').value = '#' + color.map((v) => v.toString(16).padStart(2, '0')).join('');
    setTool('pencil');
  },
});

function setEditMode(on) {
  editor.setEnabled(on);
  $('editBar').hidden = !on;
  $('editHint').hidden = !on;
  $('btnEdit').classList.toggle('on', on);
  $('btnEdit').textContent = on ? t('✓ Zakończ edycję') : t('✎ Edytuj piksele');
  updateEditButtons();
}

function setTool(tool) {
  editor.tool = tool;
  for (const b of $('editTools').children) b.setAttribute('aria-checked', String(b.dataset.tool === tool));
  editor.drawOverlay();
}

function updateEditButtons() {
  $('editUndo').disabled = !editor.undoStack.length;
  $('editRedo').disabled = !editor.redoStack.length;
  $('editClear').disabled = !edits.get(currentEditKey())?.size;
}

function clearCurrentEdits() {
  const key = currentEditKey();
  const layer = edits.get(key);
  if (!layer?.size) return;
  editor.record(key, [...layer].map(([p, v]) => [p, v, undefined]));
  edits.delete(key);
  refresh();
  updateEditButtons();
  markDirty();
}

function refresh() {
  if (!state.model && !state.cutoutImg) return;
  const yaws = directions();
  const { sprites, palette } = renderSprites(yaws);
  state.sprites = sprites;
  state.yaws = yaws;
  state.dirIndex = Math.min(state.dirIndex, sprites.length - 1);
  drawStrip();
  drawSelected();
  drawPalette(palette);
  setExportEnabled(true);
  if (state.model) {
    // „jak kierunki” – klatki są już gotowe, więc od razu; gęstsze klatki liczymy chwilę po ostatniej zmianie
    if (animFollowsDirections()) buildAnimFrames();
    else scheduleAnimFrames();
  }
}

function drawSelected() {
  const img = state.sprites[state.dirIndex];
  if (!img) return;
  const c = $('spriteView');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  fitSpriteView();
  const yaw = state.yaws[state.dirIndex];
  $('spriteInfo').textContent = state.model
    ? t('({w}×{h} px · {dir} · pochylenie {p}°)', { w: img.width, h: img.height, dir: dirLabel(yaw), p: num('pitch') })
    : t('({w}×{h} px · tryb 2D – bez modelu)', { w: img.width, h: img.height });
  // strzałka w podglądzie 3D pokazuje, skąd patrzy kamera sprite'a
  const dir = viewDirection(yaw, num('pitch'));
  arrow.position.copy(dir.clone().multiplyScalar(1.55));
  arrow.setDirection(dir.clone().negate());
}

/** Rozmiar wyświetlania canvasa w pudełku (canvas nie respektuje object-fit – liczymy ręcznie, z zachowaniem proporcji). */
function fitCanvas(c, box) {
  if (!c.width || !box.clientWidth) return;
  const k = Math.min((box.clientWidth * 0.94) / c.width, (box.clientHeight * 0.94) / c.height);
  c.style.width = `${c.width * k}px`;
  c.style.height = `${c.height * k}px`;
}
const fitSpriteView = () => { fitCanvas($('spriteView'), $('spriteBox')); editor.drawOverlay(); };
new ResizeObserver(fitSpriteView).observe($('spriteBox'));
new ResizeObserver(() => fitCanvas($('animView'), $('animBox'))).observe($('animBox'));

/** Rozmiar miniatury kierunku: tyle, żeby wszystkie zmieściły się w doku (maks. 64 px). */
function thumbSize() {
  const n = Math.max(1, state.sprites.length);
  const avail = $('strip').clientWidth || 600;
  // szerokość kafelka = miniatura + 4 px, odstęp 4 px → n kafelków zawsze mieści się w jednym rzędzie
  return Math.max(12, Math.min(64, Math.floor((avail - (n - 1) * 4) / n) - 4));
}
new ResizeObserver(() => { if (state.sprites.length) drawStrip(); }).observe($('strip'));

function drawStrip() {
  const strip = $('strip');
  const size = thumbSize();
  strip.classList.toggle('compact', size < 34);   // za małe na podpis kąta – kąt w podpowiedzi po najechaniu
  strip.replaceChildren(...state.sprites.map((img, i) => {
    const el = document.createElement('div');
    el.className = 'dir' + (i === state.dirIndex ? ' sel' : '');
    el.style.width = `${size + 4}px`;
    const c = spriteCanvas(img);
    c.classList.add('checker');
    const k = size / Math.max(img.width, img.height);   // wszystkie kierunki mieszczą się w jednym rzędzie
    c.style.width = `${img.width * k}px`;
    c.style.height = `${img.height * k}px`;
    if (edits.get(editKey(state.yaws[i]))?.size) el.classList.add('edited');   // ✎ – kierunek ma poprawki
    el.title = el.classList.contains('edited') ? t('Ten kierunek ma ręczne poprawki') : '';
    const label = document.createElement('span');
    label.textContent = state.model ? `${Math.round(state.yaws[i] * 10) / 10}°` : '2D';
    el.title ||= state.model ? dirLabel(state.yaws[i]) : '';
    el.append(c, label);
    el.addEventListener('click', () => selectDir(i));
    return el;
  }));
}

function selectDir(i) {
  const n = state.sprites.length;
  if (!n) return;
  state.dirIndex = ((i % n) + n) % n;
  [...$('strip').children].forEach((el, k) => el.classList.toggle('sel', k === state.dirIndex));
  drawSelected();
  updateEditButtons();
}

function drawPalette(palette) {
  $('paletteCount').textContent = palette.length ? `(${colorsWord(palette.length)})` : t('(bez limitu)');
  $('palette').replaceChildren(...palette.map(([r, g, b]) => {
    const s = document.createElement('span');
    s.style.background = `rgb(${r},${g},${b})`;
    s.title = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    s.addEventListener('click', () => {   // kolor z palety → ołówek edytora
      $('editColor').value = s.title;
      if (!editor.enabled) setEditMode(true);
      setTool('pencil');
    });
    return s;
  }));
}

// ---------- Animacja obrotu (na żywo, zawsze widoczna) ----------
// Klatki liczymy chwilę po ostatniej zmianie ustawień – przesuwanie suwaka nie „zamula” podglądu.
function scheduleAnimFrames() {
  clearTimeout(anim.buildTimer);
  anim.buildTimer = setTimeout(buildAnimFrames, 350);
}

/** „jak kierunki” = animacja z tych samych widoków co arkusz (liczba kierunków z Kamery). */
const animFollowsDirections = () => $('animFrames').value === 'dirs';

function buildAnimFrames() {
  clearTimeout(anim.buildTimer);
  if (!state.model) return;
  if (state.action) {
    // S10: animacja ruchu – klatki klipu dla wybranego kierunku (zamiast obrotu)
    const n = num('clipFrames'), yaw = state.yaws[state.dirIndex] ?? 0, dur = state.action.getClip().duration;
    anim.frames = Array.from({ length: n }, (_, i) => renderSprites([yaw], (i / n) * dur).sprites[0]);
    applyClipPose(clipFrameTime());   // z powrotem klatka wybrana suwakiem
  } else if (animFollowsDirections()) {
    anim.frames = state.sprites;   // już policzone – bez dodatkowego renderu
  } else {
    const n = num('animFrames');
    anim.frames = renderSprites(Array.from({ length: n }, (_, i) => (i * 360) / n)).sprites;
  }
  anim.index %= anim.frames.length;
  $('animHint').hidden = true;
  $('btnPause').disabled = false;
  updateAnimInfo();
  restartAnim();
}

function updateAnimInfo() {
  $('animFrames').options[0].dataset.sub = framesWord(num('dirCount'));   // podpis pod przyciskiem „Jak kierunki”
  if (!anim.frames.length) return;
  $('animInfo').textContent = `(${framesWord(anim.frames.length)} · ${num('gifDuration')} s)`;
  $('animInfo').title = t('Tak będzie wyglądał zapisany GIF');
}

function drawAnimFrame() {
  const img = anim.frames[anim.index];
  if (!img) return;
  const c = $('animView');
  if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
  c.getContext('2d').putImageData(img, 0, 0);
  fitCanvas(c, $('animBox'));
}

function restartAnim() {
  clearInterval(anim.timer);
  anim.timer = 0;
  drawAnimFrame();
  if (!anim.paused && anim.frames.length > 1) {
    // S10: przy animacji ruchu pętla trwa tyle, co klip (nie „pełny obrót w … s”)
    const total = state.action ? state.action.getClip().duration : num('gifDuration');
    anim.timer = setInterval(() => {
      anim.index = (anim.index + 1) % anim.frames.length;
      drawAnimFrame();
    }, (total * 1000) / anim.frames.length);
  }
  $('btnPause').textContent = anim.paused ? '▶' : '❚❚';
  $('btnPause').title = anim.paused ? t('Wznów animację (spacja)') : t('Zatrzymaj animację (spacja)');
}

function togglePause() {
  if (!anim.frames.length) return;
  anim.paused = !anim.paused;
  restartAnim();
}

function clearAnim() {
  clearTimeout(anim.buildTimer);
  clearInterval(anim.timer);
  anim.frames = [];
  anim.timer = 0;
  const c = $('animView');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  $('animHint').hidden = false;
  $('animInfo').textContent = '';
  $('btnPause').disabled = true;
}

// ---------- Komunikacja z serwerem ----------
async function postRaw(url, form) {
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).detail ?? msg; } catch { /* odpowiedź bez JSON */ }
    throw new Error(msg);
  }
  return res;
}
const post = async (url, form) => (await postRaw(url, form)).blob();

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'status ' + kind;
}

// ---------- Zakładki panelu ----------
// Zakładka jest dostępna od danego etapu: Kamera wymaga modelu 3D, Styl/Kolory/Zapis – zdjęcia.
const TAB_STAGE = { source: 'empty', model: 'photo', camera: 'model', style: 'photo', colors: 'photo', save: 'photo' };
const STAGE_RANK = { empty: 0, photo: 1, model: 2 };
let currentTab = 'source';

function tabAllowed(tab) {
  return STAGE_RANK[document.body.dataset.stage ?? 'empty'] >= STAGE_RANK[TAB_STAGE[tab]];
}

function setTab(tab) {
  if (!tabAllowed(tab)) tab = 'source';
  currentTab = tab;
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('paneTitle').textContent = $('tabs').querySelector(`[data-tab="${tab}"]`)?.dataset.title ?? '';
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== tab;
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');   // klik może trafić w ikonę (svg) wewnątrz przycisku
  if (b) setTab(b.dataset.tab);
});

// ---------- Etapy pracy i blokowanie ----------
// empty → tylko wgranie zdjęcia / modelu; photo → ustawienia 2D + generowanie; model → wszystko.
function setStage(stage) {
  document.body.dataset.stage = stage;
  setTab(currentTab);   // zakładka niedostępna na tym etapie (np. Kamera bez modelu) → wracamy do „Źródło”
  // model wczytany z pliku (bez zdjęcia): nie ma z czego generować ani do czego dopasować kolorów
  $('genBlock').hidden = !state.cutoutBlob;
  $('matchPhoto').parentElement.style.display = state.cutoutBlob ? '' : 'none';
  $('btnMask').hidden = !state.source;
}

/** Na czas usuwania tła / generowania blokujemy wszystko, co mogłoby podmienić zdjęcie lub model. */
function setBusy(on) {
  document.body.classList.toggle('busy', on);
  for (const id of ['file', 'glbFile', 'welcomePhoto', 'welcomeGlb', 'welcomeText', 'quality', 'engine', 'removeBg', 'btnMask', 'btnT2I', 't2iPrompt', 'btnRig', 'rigType', 'objectKind']) $(id).disabled = on;
  $('btnGenerate').disabled = on || !state.cutoutBlob;
}

const isModelFile = (f) => /\.(glb|gltf)$/i.test(f.name);

/** true = można porzucić bieżącą pracę (brak niezapisanych zmian albo użytkownik się zgodził). */
const confirmDiscard = () => !state.dirty
  || confirm(t('Bieżąca praca ma niezapisane zmiany (przycisk „Zapisz w galerii”). Porzucić je?'));

async function handleFile(file) {
  if (!file || document.body.classList.contains('busy')) return;
  if (isModelFile(file)) return loadGlbFile(file);
  if (!confirmDiscard()) return;
  if (file.type && !file.type.startsWith('image/')) {
    setStatus('cutoutStatus', t('To nie jest zdjęcie – wybierz plik JPG, PNG albo WEBP.'), 'err');
    return;
  }
  state.baseName = safeName(file.name.replace(/\.[^.]+$/, ''));
  setStatus('cutoutStatus', $('removeBg').checked ? t('Usuwanie tła…') : t('Przygotowanie…'), 'busy');
  setBusy(true);
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('remove_bg', $('removeBg').checked);
    const { touchesEdge } = await setSource(await post('/api/cutout', form));
    resetModel();   // nowe zdjęcie = nowy obiekt: stary model znika
    if (touchesEdge) {
      // obiekt dotyka krawędzi zdjęcia – najpewniej jest ucięty (dla postaci: brak stóp → zły model i szkielet)
      setStatus('cutoutStatus', $('objectKind').value === 'character'
        ? t('Uwaga: postać dotyka krawędzi obrazu – pewnie jest ucięta (np. stopy). Lepiej wygeneruj obraz ponownie (inne ziarno) albo użyj innego zdjęcia.')
        : t('Uwaga: obiekt dotyka krawędzi obrazu – może być ucięty. Model 3D będzie miał w tym miejscu płaską ścianę.'), 'warn');
    } else {
      setStatus('cutoutStatus', t('Gotowe. Teraz wygeneruj model 3D (zakładka Model).'));
    }
    setStatus('genStatus', '');
    setStage('photo');
    setTab('model');   // następny krok: „Generuj model 3D”
    scheduleRefresh();
  } catch (e) {
    setStatus('cutoutStatus', e.message, 'err');
  } finally {
    setBusy(false);
  }
}

const safeName = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'sprite';

/** Całe zdjęcie z maską (PNG) → stan: źródło, przycięty obiekt, miniatura, statystyki kolorów. */
async function setSource(blob, { keepAiMask = false } = {}) {
  const data = await imageDataFromBlob(blob);
  const cut = cropToObject(data);
  if (!cut) throw new Error(t('Nie został żaden fragment obiektu – przywróć go pędzlem albo wybierz inne zdjęcie.'));
  state.source = data;
  state.sourceBlob = blob;
  if (!keepAiMask) {
    state.aiMask = new Uint8ClampedArray(data.width * data.height);
    for (let p = 0; p < state.aiMask.length; p++) state.aiMask[p] = data.data[p * 4 + 3];
  }
  state.cutoutBlob = await imageDataToBlob(cut);
  state.cutoutImg = await createImageBitmap(cut);
  state.refStats = colorStats(rasterizeImage(state.cutoutImg, 256, 256));
  state.photoId++;
  $('cutoutThumb').src = URL.createObjectURL(state.cutoutBlob);
  $('cutoutThumb').hidden = false;
  return { touchesEdge: maskTouchesEdge(data) };
}

/** Czy maska obiektu dotyka krawędzi zdjęcia (obiekt ucięty w kadrze)? Dolna krawędź liczy się zawsze, boczne
 *  i górna – gdy dotyka ich wyraźny odcinek (kilka procent szerokości/wysokości), nie pojedynczy piksel. */
function maskTouchesEdge(img) {
  const { width: w, height: h, data } = img;
  const on = (x, y) => data[(y * w + x) * 4 + 3] >= 128;
  const count = (n, f) => { let c = 0; for (let i = 0; i < n; i++) if (f(i)) c++; return c; };
  const bottom = count(w, (x) => on(x, h - 1)), top = count(w, (x) => on(x, 0));
  const left = count(h, (y) => on(0, y)), right = count(h, (y) => on(w - 1, y));
  return bottom > w * 0.01 || top > w * 0.03 || left > h * 0.03 || right > h * 0.03;
}

/** Obrót „przodu” i przewrócenie dotyczą konkretnego modelu – nowy model zaczyna od zera. */
function resetOrientation() {
  tilt.quaternion.identity();
  $('baseYaw').value = 0;
  updateOutputs();
}

function resetModel() {
  resetOrientation();
  if (state.voxel) { scene.remove(state.voxel); state.voxel.dispose(); state.voxel = state.voxelData = null; }
  state.dirty = false;
  if (state.model) norm.remove(state.model);
  state.model = null;
  state.meshes = [];
  state.glbBlob = null;
  state.libraryId = null;
  clearRig();
  updateSymmetry();
  clearAnim();
  grid.visible = arrow.visible = false;
  $('btnSaveGlb').disabled = true;
  state.dirIndex = 0;
}

/** Ręczna poprawka tła (pędzel). Model trzeba potem wygenerować ponownie – mówimy o tym w statusie. */
async function editMask() {
  if (!state.source || document.body.classList.contains('busy')) return;
  const result = await maskEditor.open(state.source, state.aiMask);
  if (!result) return;
  try {
    await setSource(await imageDataToBlob(result), { keepAiMask: true });
    setStatus('cutoutStatus', t('Tło poprawione.'));
    markDirty();
    if (state.model) setStatus('genStatus', t('Tło poprawione – kliknij „Generuj model 3D”, żeby model też to uwzględnił.'));
    scheduleRefresh();
  } catch (e) {
    setStatus('cutoutStatus', e.message, 'err');
  }
}

async function loadGlbFile(f) {
  if (!f || document.body.classList.contains('busy')) return;
  if (!isModelFile(f) || !confirmDiscard()) return;
  setBusy(true);
  try {
    // inny obiekt niż na zdjęciu – zdjęcie odpinamy (nie ma czego generować ani do czego dopasować kolorów)
    state.cutoutBlob = null;
    state.cutoutImg = null;
    state.refStats = null;
    state.source = state.sourceBlob = state.aiMask = null;
    state.libraryId = null;
    resetOrientation();
    $('cutoutThumb').hidden = true;
    setStatus('cutoutStatus', '');
    state.baseName = f.name.replace(/\.[^.]+$/, '');
    state.glbBlob = f;
    clearAnim();
    await loadGlb(await f.arrayBuffer());
    $('btnSaveGlb').disabled = false;
    setStatus('cutoutStatus', t('Wczytano model {name}.', { name: f.name }));
    state.dirty = false;
    state.savedAt = null;
    updateSaveStatus();
  } catch (e) {
    setStatus('cutoutStatus', t('Nie udało się wczytać modelu: {msg}', { msg: e.message }), 'err');
  } finally {
    setBusy(false);
  }
}

async function generate() {
  if (!state.cutoutBlob) return;
  setBusy(true);
  setStatus('genStatus', t('Start…'), 'busy');
  const poll = setInterval(async () => {
    try {
      const s = await (await fetch('/api/status')).json();
      if (s.stage !== 'idle') setStatus('genStatus', `${s.stage} – ${Math.round(s.elapsed)} s`, 'busy');
    } catch { /* serwer zajęty – spróbujemy za chwilę */ }
  }, 1000);
  try {
    const form = new FormData();
    form.append('file', state.cutoutBlob, 'cutout.png');
    if (state.sourceBlob) form.append('source', state.sourceBlob, 'source.png');
    form.append('resolution', $('quality').value);
    form.append('name', state.baseName);
    form.append('kind', $('objectKind').value);
    form.append('engine', $('engineRow').hidden ? 'triposr' : $('engine').value);   // S9: dokładny silnik, gdy zainstalowany
    const t0 = performance.now();
    const res = await postRaw('/api/reconstruct', form);
    state.libraryId = res.headers.get('X-Library-Id') || null;
    const blob = await res.blob();
    state.glbBlob = blob;
    await loadGlb(await blob.arrayBuffer());
    $('btnSaveGlb').disabled = false;
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    setStatus('genStatus', state.libraryId ? t('Model gotowy ({s} s). Zapisano w galerii.', { s: secs }) : t('Model gotowy ({s} s).', { s: secs }));
    state.dirty = false;
    state.savedAt = null;
    updateSaveStatus();
    refreshRecent();
  } catch (e) {
    setStatus('genStatus', e.message, 'err');
  } finally {
    clearInterval(poll);
    setBusy(false);
  }
}

// ---------- Eksport ----------
/** Zapis pliku: do folderu z ustawień (przez serwer) albo zwykłe pobieranie do „Pobranych”. */
async function download(blob, name) {
  if (appSettings.exportDir) {
    try {
      const form = new FormData();
      form.append('file', blob, name);
      form.append('name', name);
      const r = await (await postRaw('/api/export', form)).json();
      toast(t('Zapisano: {path}', { path: r.path }));
    } catch (e) {
      toast(t('Nie udało się zapisać pliku: {msg}', { msg: e.message }), true);
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(t('Zapisywanie do folderu „Pobrane”: {name}', { name }));
}

let toastTimer = 0;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

const canvasBlob = (c) => new Promise((ok) => c.toBlob(ok, 'image/png'));

function sizeTag() {
  const { W, H } = spriteSize();
  return W === H ? `${W}px` : `${W}x${H}px`;
}

function spriteName(i) {
  if (!state.model) return `${state.baseName}_${sizeTag()}.png`;
  const yaw = String(Math.round(state.yaws[i])).padStart(3, '0');
  return `${state.baseName}_${sizeTag()}_obrot${yaw}_pochylenie${num('pitch')}.png`;
}

async function exportOne() {
  const c = spriteCanvas(state.sprites[state.dirIndex], num('exportScale'));
  download(await canvasBlob(c), spriteName(state.dirIndex));
}

async function exportSheet() {
  const scale = num('exportScale');
  const w = state.sprites[0].width * scale, h = state.sprites[0].height * scale;
  const sheet = document.createElement('canvas');
  sheet.width = w * state.sprites.length; sheet.height = h;
  const ctx = sheet.getContext('2d');
  state.sprites.forEach((img, i) => ctx.drawImage(spriteCanvas(img, scale), i * w, 0));
  const n = state.sprites.length;
  download(await canvasBlob(sheet), `${state.baseName}_${sizeTag()}_arkusz_${n}kier_pochylenie${num('pitch')}.png`);
}

async function exportAll() {
  for (let i = 0; i < state.sprites.length; i++) {
    download(await canvasBlob(spriteCanvas(state.sprites[i], num('exportScale'))), spriteName(i));
    await new Promise((r) => setTimeout(r, 250));  // przeglądarki blokują zbyt szybkie serie pobrań
  }
}

/**
 * Klatki RGBA → indeksy palety GIF. Indeks 0 = przezroczystość.
 * Zwykle kolorów jest mało (wspólna paleta), ale przy „bez limitu” redukujemy do 255.
 */
function indexFrames(frames) {
  const unique = new Map();
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]) unique.set((d[i] << 16) | (d[i + 1] << 8) | d[i + 2], null);
    }
  }
  let colors = [...unique.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  let map = null;
  if (colors.length > 255) {
    colors = medianCut(colors.flat(), 255);
    map = nearestFn(colors);
  }
  const index = new Map(colors.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i + 1]));
  const palette = [[0, 0, 0], ...colors];
  let size = 2;
  while (size < palette.length) size *= 2;
  while (palette.length < size) palette.push([0, 0, 0]);   // tabela kolorów GIF = potęga dwójki

  const indexed = frames.map((f) => {
    const d = f.data, out = new Uint8Array(f.width * f.height);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      if (!d[i + 3]) continue;
      let c = [d[i], d[i + 1], d[i + 2]];
      if (map) c = map(...c);
      out[p] = index.get((c[0] << 16) | (c[1] << 8) | c[2]);
    }
    return out;
  });
  return { palette, indexed };
}

function upscaleIndices(src, w, h, scale) {
  if (scale === 1) return src;
  const W = w * scale, out = new Uint8Array(W * h * scale);
  for (let y = 0; y < h * scale; y++) {
    const row = ((y / scale) | 0) * w;
    for (let x = 0; x < W; x++) out[y * W + x] = src[row + ((x / scale) | 0)];
  }
  return out;
}

async function exportGif() {
  if (!state.model) return;
  $('btnExportGif').disabled = true;
  setStatus('gifStatus', t('Tworzenie animacji…'), 'busy');
  await new Promise((r) => setTimeout(r, 30));   // pozwól przeglądarce odświeżyć status
  try {
    const { GIFEncoder } = await import('gifenc');
    buildAnimFrames();                 // aktualne klatki (te same, które widać w podglądzie animacji)
    const sprites = anim.frames, n = sprites.length;
    const scale = num('exportScale');
    const w = sprites[0].width, h = sprites[0].height;
    const { palette, indexed } = indexFrames(sprites);
    const gif = GIFEncoder();
    const delay = (num('gifDuration') * 1000) / n;
    indexed.forEach((idx, i) => {
      gif.writeFrame(upscaleIndices(idx, w, h, scale), w * scale, h * scale, {
        palette: i === 0 ? palette : undefined,   // jedna wspólna tabela kolorów
        delay, transparent: true, transparentIndex: 0, repeat: 0,
      });
    });
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    download(blob, `${state.baseName}_${sizeTag()}_obrot_${n}klatek_pochylenie${num('pitch')}.gif`);
    setStatus('gifStatus', t('Zapisano animację ({frames}, {kb} KB).', { frames: framesWord(n), kb: (blob.size / 1024).toFixed(0) }));
  } catch (e) {
    setStatus('gifStatus', t('Nie udało się: {msg}', { msg: e.message }), 'err');
  } finally {
    $('btnExportGif').disabled = !state.model;
  }
}

function setExportEnabled(on) {
  $('btnExportOne').disabled = !on;
  for (const id of ['btnExportSheet', 'btnExportAll', 'btnExportGif']) $(id).disabled = !on || !state.model;
}

// ---------- Presety i zapamiętywanie ustawień ----------
const getField = (id) => ($(id).type === 'checkbox' ? $(id).checked : $(id).value);
function setField(id, v) {
  const el = $(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!v;
  else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === String(v))) el.value = v;
}

for (const [key, p] of Object.entries(PALETTES)) {
  $('paletteMode').insertBefore(new Option(p.name, key), $('paletteMode').querySelector('[value=custom]'));
}
for (const [key, p] of Object.entries(PRESETS)) $('preset').add(new Option(p.name, key));

const DEFAULTS = Object.fromEntries(SAVED_FIELDS.map((id) => [id, getField(id)]));

let saveTimer = 0;
function saveSettings() {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(Object.fromEntries(SAVED_FIELDS.map((id) => [id, getField(id)]))), 300);
}

/** Po zmianie wielu pól naraz (preset, domyślne, start). */
function afterBulkChange() {
  updateOutputs();
  updatePaletteUi();
  updateOrientation();   // symetria + woksele + kadr w dobrej kolejności
  scheduleRefresh();
  saveSettings();
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  for (const [id, v] of Object.entries(p.values)) setField(id, v);
  afterBulkChange();
}

$('preset').addEventListener('change', (e) => applyPreset(e.target.value));
$('btnDefaults').addEventListener('click', () => {
  clearSaved();
  for (const [id, v] of Object.entries(DEFAULTS)) setField(id, v);
  $('preset').value = '';
  afterBulkChange();
});

// ---------- Własna paleta z pliku ----------
$('paletteFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    let colors;
    if (f.type.startsWith('image/')) {
      const bmp = await createImageBitmap(f);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      colors = paletteFromImage(ctx.getImageData(0, 0, bmp.width, bmp.height));
    } else {
      colors = parsePaletteText(await f.text());
    }
    if (colors.length < 2) throw new Error(t('w pliku nie ma co najmniej 2 kolorów'));
    state.customPalette = { name: f.name, colors };
    saveCustomPalette(state.customPalette);
    $('paletteMode').value = 'custom';
    updatePaletteUi();
    scheduleRefresh();
  } catch (err) {
    $('paletteInfo').textContent = t('Nie udało się wczytać palety: {msg}', { msg: err.message });
  } finally {
    e.target.value = '';
  }
});

// ---------- Zdarzenia ----------
$('file').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
// Przeciąganie pliku (zdjęcie albo .glb) w dowolne miejsce okna
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drag-over'); }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});
$('welcomePhoto').addEventListener('click', () => $('file').click());
$('welcomeGlb').addEventListener('click', () => $('glbFile').click());
$('btnGenerate').addEventListener('click', generate);
$('glbFile').addEventListener('change', (e) => { loadGlbFile(e.target.files[0]); e.target.value = ''; });
$('btnSaveGlb').addEventListener('click', () => download(state.glbBlob, `${state.baseName}.glb`));
$('btnExportOne').addEventListener('click', exportOne);
$('btnExportSheet').addEventListener('click', exportSheet);
$('btnExportAll').addEventListener('click', exportAll);
$('btnExportGif').addEventListener('click', exportGif);
$('btnPause').addEventListener('click', togglePause);
$('btnMask').addEventListener('click', editMask);
$('btnEdit').addEventListener('click', () => setEditMode(!editor.enabled));
$('editTools').addEventListener('click', (e) => { if (e.target.dataset.tool) setTool(e.target.dataset.tool); });
$('editColor').addEventListener('input', () => setTool('pencil'));
$('editUndo').addEventListener('click', () => applyEditValues(editor.undo()));
$('editRedo').addEventListener('click', () => applyEditValues(editor.redo()));
$('editClear').addEventListener('click', clearCurrentEdits);
$('btnGallery').addEventListener('click', openGallery);
$('btnAllGallery').addEventListener('click', openGallery);
$('galleryClose').addEventListener('click', () => $('galleryDialog').close());
$('animBox').addEventListener('click', togglePause);

// każda ręczna zmiana: zapis ustawień + „własny” styl zamiast presetu
for (const id of SAVED_FIELDS) {
  $(id).addEventListener('input', () => {
    $('preset').value = '';
    updateOutputs();
    saveSettings();
  });
}
for (const id of ['size', 'aspect', 'sampling', 'colors', 'dither', 'saturation', 'contrast', 'brightness',
  'threshold', 'outline', 'outlineColor', 'removeOrphans', 'matchPhoto', 'pitch', 'zoom', 'dirCount', 'anchor', 'shadowOpacity', 'shadowColorMode', 'shadowColor']) {
  $(id).addEventListener('input', scheduleRefresh);
}
$('paletteMode').addEventListener('input', () => { updatePaletteUi(); scheduleRefresh(); });
$('colors').addEventListener('input', updatePaletteUi);
$('animFrames').addEventListener('input', buildAnimFrames);
$('gifDuration').addEventListener('input', () => {
  if (!anim.frames.length) return;
  updateAnimInfo();
  restartAnim();
});
$('lighting').addEventListener('input', () => { applyMaterials(); scheduleRefresh(); });
$('symmetry').addEventListener('input', updateOrientation);
$('voxelMode').addEventListener('input', updateOrientation);
$('voxelRes').addEventListener('change', updateOrientation);   // przebudowa po puszczeniu suwaka (wokselizacja chwilę trwa)
$('baseYaw').addEventListener('input', () => { updateOutputs(); updateOrientation(); markDirty(); });
$('btnTiltX').addEventListener('click', () => { tilt.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2); updateOrientation(); markDirty(); });
$('btnTiltZ').addEventListener('click', () => { tilt.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), Math.PI / 2); updateOrientation(); markDirty(); });
$('btnResetTilt').addEventListener('click', () => {
  markDirty();
  tilt.quaternion.identity();
  $('baseYaw').value = 0;
  $('baseYaw').dispatchEvent(new Event('input'));
});
document.querySelectorAll('.presets').forEach((p) => p.addEventListener('click', (e) => {
  const v = e.target.dataset?.v;
  if (v === undefined) return;
  const input = $(p.dataset.target);
  input.value = v;
  input.dispatchEvent(new Event('input'));
}));
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;                  // okno dialogowe ma własne skróty
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {        // Ctrl+S = zapisz w galerii
    e.preventDefault();
    saveToGallery();
    return;
  }
  if (editor.enabled && (e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); applyEditValues(editor.undo()); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); applyEditValues(editor.redo()); return; }
  }
  if (e.target.closest?.('input, select, textarea, button')) return;   // klawisze w polach formularza zostawiamy im
  if (editor.enabled && !e.ctrlKey && !e.metaKey) {
    const tool = { b: 'pencil', e: 'eraser', i: 'picker' }[e.key.toLowerCase()];
    if (tool) { setTool(tool); return; }
  }
  if (e.key === 'ArrowLeft') selectDir(state.dirIndex - 1);
  if (e.key === 'ArrowRight') selectDir(state.dirIndex + 1);
  if (e.key === ' ') { e.preventDefault(); togglePause(); }
});

// ---------- Galeria ----------
const maskEditor = new MaskEditor();

async function refreshRecent() {
  try {
    const list = await listEntries();
    renderTiles($('recent'), list.slice(0, 6), { open: openEntry });
    $('recentBox').hidden = !list.length;
    return list;
  } catch {
    $('recentBox').hidden = true;   // serwer bez galerii – ekran startowy działa dalej
    return [];
  }
}

async function openGallery() {
  const list = await refreshRecent();
  $('galleryEmpty').hidden = !!list.length;
  renderTiles($('galleryTiles'), list, {
    open: openEntry,
    async rename(entry) {
      const name = prompt(t('Nowa nazwa:'), entry.name);
      if (!name?.trim()) return;
      await renameEntry(entry, name.trim());
      openGallery();
    },
    async remove(entry) {
      if (!confirm(t('Usunąć „{name}” z galerii? Tego nie da się cofnąć.', { name: entry.name }))) return;
      await deleteEntry(entry);
      if (state.libraryId === entry.id) state.libraryId = null;
      openGallery();
    },
  });
  if (!$('galleryDialog').open) $('galleryDialog').showModal();
}

/** Wpis z galerii: zdjęcie z maską + gotowy model – bez ponownego liczenia AI. */
async function openEntry(entry) {
  if (document.body.classList.contains('busy')) return;
  if (!confirmDiscard()) return;
  if ($('galleryDialog').open) $('galleryDialog').close();
  setBusy(true);
  setStatus('cutoutStatus', t('Otwieranie z galerii…'), 'busy');
  try {
    // S10: wpis ze szkieletem otwieramy z rigged.glb (ta sama siatka + kości i wagi skórowania)
    const [source, glb] = await Promise.all([fetchFile(entry, 'source.png'), fetchFile(entry, entry.rigged ? 'rigged.glb' : 'model.glb')]);
    await setSource(source);
    resetModel();
    state.baseName = safeName(entry.name);
    state.glbBlob = glb;
    state.libraryId = entry.id;
    await loadGlb(await glb.arrayBuffer());
    const project = await fetchProject(entry);
    if (project) applyProject(project);
    else if (entry.kind) { setField('objectKind', entry.kind); renderKindUi(); }
    $('btnSaveGlb').disabled = false;
    setStatus('cutoutStatus', t(project ? 'Otwarto z galerii: {name} (z zapisanymi zmianami)' : 'Otwarto z galerii: {name}', { name: entry.name }));
    setStatus('genStatus', '');
    state.dirty = false;
    state.savedAt = entry.updated ? new Date(entry.updated * 1000) : null;
    updateSaveStatus();
  } catch (e) {
    setStatus('cutoutStatus', t('Nie udało się otworzyć: {msg}', { msg: e.message }), 'err');
  } finally {
    setBusy(false);
  }
}

// ---------- Zapis pracy w galerii ----------
// Zapisujemy wszystko, czego nie da się odtworzyć z samego modelu: ustawienia, obrót „przodu”, przewrócenie,
// poprawki pikseli (dla tego modelu) i poprawione tło. Miniatura w galerii = aktualny pixel-art (widok z przodu).
function markDirty() {
  if (!state.model || state.dirty) return;
  state.dirty = true;
  updateSaveStatus();
}

function updateSaveStatus() {
  window.pywebview?.api?.set_dirty(state.dirty);   // okno programu: pytanie przy zamykaniu bez odpytywania strony
  if (state.dirty) return setStatus('saveStatus', t('● Niezapisane zmiany'), 'warn');
  if (!state.libraryId) return setStatus('saveStatus', t('Tego modelu nie ma jeszcze w galerii.'));
  const at = state.savedAt?.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  setStatus('saveStatus', at ? t('Zapisano w galerii ({time}).', { time: at }) : t('Zapisane w galerii.'));
}

function projectData() {
  const prefix = `3d:${state.modelId}|`;   // poprawki tylko dla tego modelu, bez numeru sesji w kluczu
  const layers = {};
  for (const [key, layer] of edits) {
    if (key.startsWith(prefix) && layer.size) layers[key.slice(prefix.length)] = [...layer].map(([p, c]) => [p, ...c]);
  }
  const q = tilt.quaternion;
  return {
    version: 1,
    settings: Object.fromEntries(SAVED_FIELDS.map((id) => [id, getField(id)])),
    customPalette: $('paletteMode').value === 'custom' ? state.customPalette : null,
    baseYaw: num('baseYaw'),
    tilt: [q.x, q.y, q.z, q.w],
    edits: layers,
  };
}

function applyProject(p) {
  for (const [id, v] of Object.entries(p.settings ?? {})) if (SAVED_FIELDS.includes(id)) setField(id, v);
  if (p.customPalette) {
    state.customPalette = p.customPalette;
    saveCustomPalette(p.customPalette);
  }
  $('baseYaw').value = p.baseYaw ?? 0;
  if (Array.isArray(p.tilt)) tilt.quaternion.fromArray(p.tilt);
  const prefix = `3d:${state.modelId}|`;
  for (const [key, list] of Object.entries(p.edits ?? {})) {
    edits.set(prefix + key, new Map(list.map(([px, r, g, b, a]) => [px, [r, g, b, a]])));
  }
  $('preset').value = '';
  afterBulkChange();
  renderKindUi();
  if (state.rig?.humanoid) {   // „ręce w dół” z zapisanego projektu – model jest już wczytany (setupRig był wcześniej)
    setArmsDown(state.rig, state.model, $('armsDown').checked);
    selectClip($('animClip').value);
  }
  updateOrientation();
  updateEditButtons();
}

async function galleryThumb() {
  const img = state.sprites[0];   // kierunek 0 = przód
  if (!img) return null;
  return canvasBlob(spriteCanvas(img, Math.max(1, Math.floor(192 / Math.max(img.width, img.height)))));
}

async function saveToGallery() {
  if (!state.model || document.body.classList.contains('busy')) return;
  $('btnSaveGallery').disabled = true;
  setStatus('saveStatus', t('Zapisywanie…'), 'busy');
  try {
    const thumb = await galleryThumb();
    if (!state.libraryId) state.libraryId = await createEntry(state.glbBlob, state.sourceBlob, thumb, state.baseName, $('objectKind').value);
    await saveProject(state.libraryId, projectData(), state.sourceBlob, thumb);
    state.dirty = false;
    state.savedAt = new Date();
    updateSaveStatus();
    refreshRecent();
  } catch (e) {
    setStatus('saveStatus', t('Nie udało się zapisać: {msg}', { msg: e.message }), 'err');
  } finally {
    $('btnSaveGallery').disabled = false;
  }
}

$('btnSaveGallery').addEventListener('click', saveToGallery);
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }   // przeglądarka zapyta, czy na pewno wyjść
});

// ---------- Wersja, aktualizacje, sprzęt („O programie”) ----------
// Sprawdzanie aktualizacji robi serwer (w tle, przy starcie). Tu tylko pokazujemy stan i klikamy „Pobierz”.
window.pixelForgeIsDirty = () => state.dirty;   // okno programu pyta przed zamknięciem

let updateInfo = null;
let updateDismissed = false;

function renderUpdate(u) {
  updateInfo = u;
  const bar = $('updateBar'), action = $('updateAction'), text = $('updateText');
  const aboutText = $('aboutUpdate'), aboutAction = $('aboutUpdateAction');
  let barText = '', actionText = '', aboutMsg = '';
  if (u.downloaded) {
    barText = t('Wersja {v} jest pobrana.', { v: u.downloaded });
    actionText = t('Uruchom ponownie i zainstaluj');
    aboutMsg = t('Wersja {v} jest pobrana – zainstaluje się po ponownym uruchomieniu.', { v: u.downloaded });
  } else if (u.downloading) {
    barText = t('Pobieranie wersji {v}… {p}%', { v: u.available?.version, p: Math.round(u.progress * 100) });
    aboutMsg = barText;
  } else if (u.available) {
    barText = u.available.date
      ? t('Dostępna nowa wersja {v} ({date}).', { v: u.available.version, date: u.available.date })
      : t('Dostępna nowa wersja {v}.', { v: u.available.version });
    actionText = t('Pobierz');
    aboutMsg = barText;
  } else if (u.error) {
    aboutMsg = u.error;
  } else if (!u.configured) {
    aboutMsg = t('Aktualizacje nie są jeszcze skonfigurowane (brak adresu w config/update.json).');
  } else if (u.checking) {
    aboutMsg = t('Sprawdzanie…');
  } else {
    aboutMsg = u.checkedAt
      ? t('Masz najnowszą wersję (sprawdzono {time}).', { time: new Date(u.checkedAt * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })
      : t('Masz najnowszą wersję.');
  }
  bar.hidden = !barText || updateDismissed;
  text.textContent = barText;
  action.textContent = actionText;
  action.hidden = !actionText;
  $('updateNotes').hidden = !u.available?.notes;
  aboutText.textContent = aboutMsg;
  aboutText.className = 'status ' + (u.error ? 'err' : u.downloading || u.checking ? 'busy' : '');
  aboutAction.textContent = actionText;
  aboutAction.hidden = !actionText;
  $('aboutCheck').disabled = !!u.checking || !!u.downloading;
}

async function pollUpdate() {
  try { renderUpdate(await (await fetch('/api/update')).json()); } catch { /* serwer niedostępny */ }
}

async function updateAction() {
  if (!updateInfo) return;
  if (updateInfo.downloaded) {
    if (!confirmDiscard()) return;
    const r = await (await fetch('/api/update/restart', { method: 'POST' })).json();
    if (!r.desktop) alert(t('Zamknij czarne okno programu i uruchom start.bat ponownie – aktualizacja zainstaluje się przy starcie.'));
    return;
  }
  if (updateInfo.available && !updateInfo.downloading) {
    await fetch('/api/update/download', { method: 'POST' });
    updateDismissed = false;
    const tick = setInterval(async () => {
      await pollUpdate();
      if (!updateInfo.downloading) clearInterval(tick);
    }, 700);
  }
}

$('updateAction').addEventListener('click', updateAction);
$('aboutUpdateAction').addEventListener('click', updateAction);
$('updateNotes').addEventListener('click', () => alert(`${t('Co nowego w wersji {v}:', { v: updateInfo?.available?.version })}\n\n${updateInfo?.available?.notes}`));
$('updateLater').addEventListener('click', () => { updateDismissed = true; $('updateBar').hidden = true; });
$('aboutCheck').addEventListener('click', async () => {
  $('aboutCheck').disabled = true;
  setStatus('aboutUpdate', t('Sprawdzanie…'), 'busy');
  try { renderUpdate(await (await fetch('/api/update/check', { method: 'POST' })).json()); }
  catch (e) { setStatus('aboutUpdate', t('Nie udało się sprawdzić: {msg}', { msg: e.message }), 'err'); $('aboutCheck').disabled = false; }
});

async function openAbout() {
  $('aboutVersion').textContent = updateInfo?.current ? t('wersja {v}', { v: updateInfo.current }) : '';
  $('aboutDialog').showModal();
  try {
    const { hardware: hw, features } = await (await fetch('/api/capabilities')).json();
    const rows = [
      [t('Karta graficzna'), hw.gpu ? `${hw.gpu} (${hw.vramGb} GB)` : t('nie wykryto karty NVIDIA')],
      [t('Obsługa CUDA (AI na karcie)'), hw.cuda ? t('tak') : t('nie – AI liczy procesor')],
      [t('Pamięć RAM'), hw.ramGb ? `${hw.ramGb} GB` : '—'],
      [t('Wolne miejsce na dysku'), `${hw.diskFreeGb} GB`],
      ['PyTorch', hw.torch || '—'],
    ];
    $('aboutHardware').replaceChildren(...rows.map(([k, v]) => {
      const tr = document.createElement('tr');
      tr.append(Object.assign(document.createElement('td'), { textContent: k }), Object.assign(document.createElement('td'), { textContent: v }));
      return tr;
    }));
    await Promise.all([checkT2I(), checkMultiview()]);   // stan instalacji funkcji (przycisk „Zainstaluj” / postęp)
    $('aboutFeatures').replaceChildren(...Object.entries(features).map(([key, f]) => {
      const box = document.createElement('div');
      box.className = 'feature';
      const title = document.createElement('b');
      title.textContent = f.name;
      const st = document.createElement('span');
      st.className = 'state ' + (f.available ? 'ok' : 'locked');
      st.textContent = f.available ? (f.installed ? t('gotowe') : t('dostępne – do zainstalowania')) : t('zablokowane');
      title.append(st);
      const desc = document.createElement('p');
      desc.textContent = t('{desc} Wymagania: karta {vram} GB, RAM {ram} GB, dysk {disk} GB.', { desc: f.description, vram: f.vram, ram: f.ram, disk: f.disk });
      box.append(title, desc);
      if (f.reasons.length) {
        const ul = document.createElement('ul');
        ul.append(...f.reasons.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
        box.append(ul);
      }
      box.append(...featureInstallControls(key, f));
      return box;
    }));
  } catch (e) {
    $('aboutHardware').textContent = t('Nie udało się odczytać: {msg}', { msg: e.message });
  }
}

$('btnAbout').addEventListener('click', openAbout);
$('btnSettings').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => $('settingsDialog').close());
$('aboutClose').addEventListener('click', () => $('aboutDialog').close());
pollUpdate();
setTimeout(pollUpdate, 4000);   // sprawdzanie w tle trwa chwilę po starcie

// ---------- Modele AI: pasek, gdy czegoś brakuje (np. instalacja bez internetu) ----------
let modelsInfo = null;

function renderModels(m) {
  modelsInfo = m;
  const bar = $('modelsBar'), action = $('modelsAction');
  bar.hidden = m.complete && !m.downloading;
  if (bar.hidden) return;
  bar.title = m.error ?? '';   // szczegóły techniczne tylko w podpowiedzi
  if (m.downloading) {
    const cur = m.missing.find((x) => x.key === m.current) ?? m.missing[0];
    $('modelsText').textContent = t('Pobieranie modeli AI: {name}… To może potrwać kilka minut.', { name: cur?.name ?? '' });
    action.hidden = true;
  } else if (m.error) {
    $('modelsText').textContent = t('Nie udało się pobrać modeli AI – sprawdź połączenie z internetem.');
    action.textContent = t('Spróbuj ponownie');
    action.hidden = false;
  } else {
    $('modelsText').textContent = t('Brakuje modeli AI (ok. {mb} MB). Bez nich nie da się usuwać tła ani tworzyć modeli 3D. Pobieranie jest jednorazowe – potem program działa bez internetu.', { mb: m.missingMb });
    action.textContent = t('Pobierz teraz');
    action.hidden = false;
  }
}

async function checkModels() {
  try { renderModels(await (await fetch('/api/models')).json()); } catch { /* serwer niedostępny */ }
}

$('modelsAction').addEventListener('click', async () => {
  renderModels(await (await fetch('/api/models/download', { method: 'POST' })).json());
  const tick = setInterval(async () => {
    await checkModels();
    if (!modelsInfo.downloading) {
      clearInterval(tick);
      if (modelsInfo.complete) toast(t('Modele AI pobrane – program może działać bez internetu.'));
    }
  }, 1500);
});

// ---------- S8: tekst → obraz (funkcja zaawansowana; widoczna, gdy zainstalowana) ----------
let t2iInfo = null;
let rigInfo = null;   // S10: stan funkcji „Szkielet i animacje” (deklaracja tu – renderKindUi woła renderRigUi wcześniej)

function renderT2I() {
  const on = !!t2iInfo?.installed;
  $('t2iBlock').hidden = !on;
  $('welcomeText').hidden = !on;
}

async function checkT2I() {
  try { t2iInfo = await (await fetch('/api/text2image')).json(); renderT2I(); } catch { /* serwer niedostępny */ }
  return t2iInfo;
}

$('welcomeText').addEventListener('click', () => { setTab('source'); $('t2iPrompt').focus(); });

/** Opis → obraz (serwer) → dalej jak zwykłe zdjęcie: usunięcie tła, model 3D. */
async function generateFromText() {
  const prompt = $('t2iPrompt').value.trim();
  if (!prompt) { setStatus('t2iStatus', t('Wpisz, co ma przedstawiać obraz.'), 'err'); return; }
  if (document.body.classList.contains('busy') || !confirmDiscard()) return;
  setBusy(true);
  setStatus('t2iStatus', t('Generowanie obrazu (AI)… Za pierwszym razem wczytanie modelu trwa około minuty.'), 'busy');
  try {
    const seed = $('t2iSeed').value;
    const res = await fetch('/api/text2image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, seed: seed === '' ? null : Number(seed), kind: $('objectKind').value }),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { msg = (await res.json()).detail ?? msg; } catch { /* bez JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    setStatus('t2iStatus', t('Obraz gotowy – usuwanie tła…'), 'busy');
    setBusy(false);
    await handleFile(new File([blob], `${safeName(prompt.slice(0, 40))}.png`, { type: 'image/png' }));
    setStatus('t2iStatus', '');
  } catch (e) {
    setStatus('t2iStatus', e.message, 'err');
  } finally {
    setBusy(false);
  }
}

// Rodzaj obiektu (zakładka Źródło): podpowiedź przy opisie, przykład w polu, blok szkieletu (tylko postać/stworzenie)
const KIND_UI = {
  character: { tip: 'Program dopisze: cała postać w T-pozie, od głowy do stóp, przodem, na białym tle (obraz pionowy).', example: 'np. medieval knight in plate armor' },
  creature: { tip: 'Program dopisze: całe zwierzę z nogami i ogonem, widok trzy czwarte, na białym tle.', example: 'np. red dragon with big wings' },
  building: { tip: 'Program dopisze: cały budynek od ziemi do dachu, widok z narożnika, bez otoczenia.', example: 'np. small stone tower with a wooden roof' },
  object: { tip: 'Program dopisze: cały przedmiot, widok trzy czwarte, na białym tle.', example: 'np. golden treasure chest' },
};
function renderKindUi() {
  const k = KIND_UI[$('objectKind').value] ?? KIND_UI.object;
  $('t2iKindTip').textContent = t(k.tip);
  $('t2iPrompt').placeholder = t(k.example);
  renderRigUi();
}
$('objectKind').addEventListener('input', renderKindUi);
renderKindUi();   // stan zapamiętany z poprzedniej sesji (SAVED_FIELDS)

$('btnT2I').addEventListener('click', generateFromText);
$('t2iPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateFromText(); });
checkT2I();   // czy funkcja jest zainstalowana → przyciski w Źródle i na ekranie startowym

// ---------- S9: lepszy tył obiektu (silnik InstantMesh; widoczny w zakładce Model, gdy zainstalowany) ----------
let mvInfo = null;

function renderMultiview() {
  $('engineRow').hidden = !mvInfo?.installed;
}

async function checkMultiview() {
  try { mvInfo = await (await fetch('/api/multiview')).json(); renderMultiview(); } catch { /* serwer niedostępny */ }
  return mvInfo;
}
checkMultiview();

// Funkcje zaawansowane instalowane z okna „Sprzęt i zaawansowane AI”: adres API, stan, komunikat po instalacji.
const FEATURE_UI = {
  text2image: { api: '/api/text2image', check: checkT2I, info: () => t2iInfo,
    done: () => t('Funkcja „Tekst → obraz” jest gotowa. Na ekranie startowym pojawił się przycisk „Opisz słowami”.') },
  multiview: { api: '/api/multiview', check: checkMultiview, info: () => mvInfo,
    done: () => t('Funkcja „Lepszy tył obiektu” jest gotowa. W zakładce Model pojawił się wybór silnika 3D.'),
    note: () => t('Licencja: wagi modelu Zero123++ są na licencji CC-BY-NC 4.0 (bez użycia w produktach komercyjnych); wygenerowane modele i sprite\'y możesz wykorzystywać dowolnie.') },
  rigging: { api: '/api/rigging', check: () => checkRigging(), info: () => rigInfo,
    done: () => t('Funkcja „Szkielet i animacje” jest gotowa. W zakładce Model pojawił się przycisk „Utwórz szkielet”.'),
    note: () => t('Instaluje własny Python 3.11 z Blenderem (bpy) i UniRig (MIT) – ok. 10 GB.') },
};

/** Przycisk „Zainstaluj” w oknie „Sprzęt i zaawansowane AI” + pasek postępu pobierania. */
function featureInstallControls(key, feature) {
  const ui = FEATURE_UI[key];
  if (!ui || !feature.available) return [];
  const out = [];
  if (ui.note) out.push(Object.assign(document.createElement('p'), { className: 'muted', textContent: ui.note() }));
  const wrap = document.createElement('div');
  wrap.className = 'feat-install';
  const btn = document.createElement('button');
  btn.type = 'button';
  const prog = document.createElement('span');
  prog.className = 'muted';
  const paint = (info) => {
    if (info?.installed) { btn.hidden = true; prog.textContent = t('zainstalowane'); return; }
    if (info?.installing) {
      btn.hidden = true;
      prog.textContent = t('Pobieranie {pct}% – {what}', { pct: Math.round((info.progress ?? 0) * 100), what: info.current ?? '' });
      return;
    }
    btn.hidden = false;
    btn.textContent = t('Zainstaluj (ok. {gb} GB, jednorazowo)', { gb: Math.round((info?.sizeMb ?? 10000) / 1000) });
    prog.textContent = info?.error ?? '';
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      paint(await (await fetch(`${ui.api}/install`, { method: 'POST' })).json());
      const tick = setInterval(async () => {
        const info = await ui.check();
        paint(info);
        if (info && !info.installing) {
          clearInterval(tick);
          if (info.installed) toast(ui.done());
        }
      }, 1500);
    } catch (e) { prog.textContent = e.message; btn.disabled = false; }
  });
  paint(ui.info() ?? { installed: feature.installed });
  wrap.append(btn, prog);
  out.push(wrap);
  return out;
}

// ---------- S10: szkielet i animacje (UniRig na serwerze, klipy proceduralne w rig.js) ----------

function renderRigUi() {
  const installed = !!rigInfo?.installed;
  const kind = $('objectKind').value;
  const has = !!state.rig;
  // budynek i przedmiot nie mają szkieletu; rodzaj szkieletu wynika z rodzaju obiektu (postać = kości VRoid)
  $('rigBlock').hidden = !installed || (!has && kind !== 'character' && kind !== 'creature');
  $('rigTypeRow').hidden = true;
  $('rigType').value = kind === 'character' ? 'humanoid' : 'generic';
  $('btnRig').hidden = has;
  $('animClipRow').hidden = !has;
  $('armsDownRow').hidden = !(has && state.rig.humanoid);
  $('animFrameRow').hidden = !state.action;
  $('animSheetBlock').hidden = !state.action;
  if (has) $('rigStatus').textContent = state.rig.humanoid
    ? t('Szkielet postaci ({n} kości) – wybierz animację.', { n: state.rig.bones.length })
    : t('Szkielet ogólny ({n} kości) – dostępne animacje ogólne.', { n: state.rig.bones.length });
}

async function checkRigging() {
  try { rigInfo = await (await fetch('/api/rigging')).json(); renderRigUi(); } catch { /* serwer niedostępny */ }
  return rigInfo;
}

/** Po wczytaniu GLB: czy ma szkielet? Jeśli tak – mixer i lista klipów (bez animacji na start). */
function setupRig() {
  clearRig();
  state.rig = findRig(state.model);
  if (state.rig) {
    state.mixer = new THREE.AnimationMixer(state.model);
    const sel = $('animClip');
    sel.replaceChildren(...['none', ...clipNames(state.rig)].map((n) => Object.assign(document.createElement('option'), { value: n, textContent: t(CLIP_LABELS[n]) })));
    sel.value = 'none';
    if ($('armsDown').checked && state.rig.humanoid) { setArmsDown(state.rig, state.model, true); resetPose(state.rig); }
  }
  renderRigUi();
}

// „Ręce w dół”: nowa poza spoczynkowa ramion + przebudowa bieżącego klipu (klipy liczą obroty od pozy spoczynkowej)
$('armsDown').addEventListener('input', () => {
  if (!state.rig?.humanoid) return;
  setArmsDown(state.rig, state.model, $('armsDown').checked);
  selectClip($('animClip').value);
  markDirty();
});

function clearRig() {
  if (state.mixer) state.mixer.stopAllAction();
  state.rig = state.mixer = state.action = null;
  if ($('rigBlock')) { $('animClip').value = 'none'; renderRigUi(); }
}

/** Czas klatki wybranej suwakiem (sprite'y i arkusz kierunków). */
function clipFrameTime() {
  if (!state.action) return 0;
  const n = num('clipFrames');
  return (Math.min(num('animFrame'), n - 1) / n) * state.action.getClip().duration;
}

/** Ustawia pozę klipu w chwili t (dla renderu sprite'ów – niezależnie od odtwarzania w podglądzie 3D). */
function applyClipPose(t) {
  if (!state.mixer || !state.action) return;
  state.action.paused = false;
  state.mixer.setTime(t);
  scene.updateMatrixWorld(true);
  for (const m of state.rig.skinned) m.skeleton.update();
}

function selectClip(name) {
  if (!state.rig) return;
  if (state.mixer) state.mixer.stopAllAction();
  state.action = null;
  resetPose(state.rig);
  if (name !== 'none') {
    const clip = buildClip(state.rig, name);
    if (clip) {
      state.action = state.mixer.clipAction(clip);
      state.action.setLoop(THREE.LoopRepeat, Infinity).play();
    }
  }
  // animacja ruchu wyklucza symetrię i woksele (liczone z pozy spoczynkowej) – wracamy do zwykłej bryły
  if (state.action) {
    if ($('symmetry').value !== 'off') { $('symmetry').value = 'off'; }
    if ($('voxelMode').value === 'on') { $('voxelMode').value = 'off'; }
    updateOrientation();
  }
  $('animFrame').max = num('clipFrames') - 1;
  if (num('animFrame') > num('clipFrames') - 1) $('animFrame').value = 0;
  $('animFrameOut').textContent = `${num('animFrame') + 1}/${num('clipFrames')}`;
  renderRigUi();
  scheduleRefresh();
}

$('animClip').addEventListener('input', () => { selectClip($('animClip').value); markDirty(); });
$('animFrame').addEventListener('input', () => {
  $('animFrameOut').textContent = `${num('animFrame') + 1}/${num('clipFrames')}`;
  scheduleRefresh();
});
$('clipFrames').addEventListener('input', () => {
  $('animFrame').max = num('clipFrames') - 1;
  if (num('animFrame') > num('clipFrames') - 1) $('animFrame').value = 0;
  $('animFrameOut').textContent = `${num('animFrame') + 1}/${num('clipFrames')}`;
  scheduleRefresh();
});

/** „Utwórz szkielet”: serwer (UniRig) → rigged.glb w galerii → wczytanie zamiast zwykłego modelu. */
async function rigModel() {
  if (!state.model || !state.glbBlob || document.body.classList.contains('busy')) return;
  setBusy(true);
  setStatus('rigStatus', t('Szkielet (AI)… to potrwa około minuty.'), 'busy');
  try {
    // model wczytany z pliku .glb nie ma jeszcze wpisu w galerii – szkielet zapisujemy przy wpisie
    if (!state.libraryId) state.libraryId = await createEntry(state.glbBlob, state.sourceBlob, null, state.baseName, $('objectKind').value);
  } catch (e) {
    setStatus('rigStatus', e.message, 'err');
    setBusy(false);
    return;
  }
  const poll = setInterval(async () => {
    try {
      const s = await (await fetch('/api/status')).json();
      if (s.stage !== 'idle') setStatus('rigStatus', `${s.stage} – ${Math.round(s.elapsed)} s`, 'busy');
    } catch { /* serwer zajęty */ }
  }, 1000);
  try {
    const form = new FormData();
    form.append('humanoid', $('objectKind').value === 'character');
    const res = await postRaw(`/api/library/${state.libraryId}/rig`, form);
    const blob = await res.blob();
    state.glbBlob = blob;
    await loadGlb(await blob.arrayBuffer());
    refreshRecent();
    if (res.headers.get('X-Rig-Fallback') === '1') {
      // model nie dał kompletu kości postaci (VRoid) – jest szkielet ogólny, więc tylko animacje ogólne
      setStatus('rigStatus', t('Nie udało się rozpoznać budowy postaci – utworzono szkielet ogólny (animacje: kołysanie, podskok).'), 'err');
    } else {
      renderRigUi();   // status „Szkielet postaci (n kości)…”
      toast(t('Szkielet gotowy – wybierz animację w zakładce Model.'));
    }
  } catch (e) {
    setStatus('rigStatus', e.message, 'err');
  } finally {
    clearInterval(poll);
    setBusy(false);
  }
}
$('btnRig').addEventListener('click', rigModel);

/** Arkusz animacji: wiersz = kierunek, kolumna = klatka ruchu. */
async function exportAnimSheet() {
  if (!state.action || !state.sprites.length) return;
  const n = num('clipFrames'), scale = num('exportScale'), yaws = directions();
  const dur = state.action.getClip().duration;
  setStatus('animSheetStatus', t('Renderowanie {n} klatek × {d} kierunków…', { n, d: yaws.length }), 'busy');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const columns = [];
    for (let i = 0; i < n; i++) columns.push(renderSprites(yaws, (i / n) * dur).sprites);
    applyClipPose(clipFrameTime());
    const w = columns[0][0].width * scale, h = columns[0][0].height * scale;
    const sheet = document.createElement('canvas');
    sheet.width = w * n; sheet.height = h * yaws.length;
    const ctx = sheet.getContext('2d');
    columns.forEach((col, i) => col.forEach((img, j) => ctx.drawImage(spriteCanvas(img, scale), i * w, j * h)));
    const clip = state.action.getClip().name;
    download(await canvasBlob(sheet), `${state.baseName}_${sizeTag()}_${clip}_${n}klatek_${yaws.length}kier.png`);
    setStatus('animSheetStatus', t('Zapisano arkusz {w}×{h} px.', { w: sheet.width, h: sheet.height }));
  } catch (e) {
    setStatus('animSheetStatus', e.message, 'err');
  }
}
$('btnExportAnimSheet').addEventListener('click', exportAnimSheet);
checkRigging();

// ---------- Motyw jasny / ciemny ----------
// Dopóki użytkownik nie kliknie, motyw idzie za ustawieniem Windows; kliknięcie zapisuje wybór na stałe.
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme ?? (systemDark.matches ? 'dark' : 'light');

function updateThemeButton() {
  const dark = currentTheme() === 'dark';
  document.documentElement.classList.toggle('is-dark', dark);   // steruje ikoną słońca/księżyca
  $('themeToggle').title = dark ? t('Przełącz na motyw jasny') : t('Przełącz na motyw ciemny');
}

$('themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('pixelforge.theme', next); } catch { /* brak zapisu – trudno */ }
  updateThemeButton();
});
systemDark.addEventListener('change', updateThemeButton);
updateThemeButton();

// ---------- Ustawienia programu (zębatka) ----------
// Trzymane przez serwer w config/settings.json (tak samo w oknie programu i w przeglądarce).
let appSettings = { language: 'en', exportDir: '', checkUpdatesOnStart: true, downloadsDir: '', desktop: false };

async function loadSettings() {
  try { appSettings = await (await fetch('/api/settings')).json(); } catch { /* serwer niedostępny – domyślne */ }
}

async function saveAppSettings(changes) {
  const res = await fetch('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail ?? res.status);
  appSettings = data;
  renderSettings();
}

function renderSettings() {
  $('setLanguage').value = appSettings.language;
  const folder = appSettings.exportDir || appSettings.downloadsDir;   // pusty = domyślne „Pobrane”
  $('setExportPath').textContent = folder;
  $('setExportBox').title = folder;
  $('setCheckUpdates').checked = appSettings.checkUpdatesOnStart;
}

async function openSettings() {
  await loadSettings();
  renderSettings();
  setStatus('setExportStatus', '');
  $('settingsDialog').showModal();
  pollUpdate();
  showDevice();
}

/** Zmiana języka bez przeładowania: statyczne teksty + wszystko, co kod wstawia na ekran. */
function applyLanguage(lang) {
  setLang(lang);
  try { localStorage.setItem('pixelforge.lang', lang); } catch { /* brak zapisu – trudno */ }
  translateDom(document.body);
  setTab(currentTab);                 // tytuł zakładki
  setEditMode(editor.enabled);        // napis „Edytuj piksele”
  updateOutputs();
  updatePaletteUi();
  updateAnimInfo();
  restartAnim();
  updateEditButtons();
  updateThemeButton();
  if (state.sprites.length) { drawStrip(); drawSelected(); }
  if (state.model) updateSaveStatus();
  if (updateInfo) renderUpdate(updateInfo);
  renderSettings();
  showDevice();
  refreshRecent();
  if (modelsInfo) renderModels(modelsInfo);
}

$('setLanguage').addEventListener('input', async (e) => {
  const lang = e.target.value;
  applyLanguage(lang);
  try { await saveAppSettings({ language: lang }); } catch (err) { toast(err.message, true); }
});
$('setExportPick').addEventListener('click', async () => {
  let path;
  const r = await (await fetch('/api/settings/pick-folder', { method: 'POST' })).json();
  if (r.supported) path = r.path;   // okno programu: systemowe okno wyboru folderu
  else path = prompt(t('Podaj pełną ścieżkę folderu zapisu:'), appSettings.exportDir || appSettings.downloadsDir);
  if (!path) return;
  try {
    await saveAppSettings({ exportDir: path });
    setStatus('setExportStatus', '');
  } catch (e) {
    setStatus('setExportStatus', e.message, 'err');
  }
});
$('setExportOpen').addEventListener('click', () => fetch('/api/settings/open-folder', { method: 'POST' }));
$('setCheckUpdates').addEventListener('change', (e) => saveAppSettings({ checkUpdatesOnStart: e.target.checked }));

// ---------- Start ----------
for (const [id, v] of Object.entries(loadSaved())) if (SAVED_FIELDS.includes(id)) setField(id, v);
updateOutputs();
updatePaletteUi();
updateAnimInfo();
setStage('empty');
setTool('pencil');
updateEditButtons();
refreshRecent();
await loadSettings();
applyLanguage(appSettings.language);
checkModels();
document.documentElement.classList.remove('i18n-pending');
window.pixelForgeReady = true;   // sprawdzane przez skrypt w index.html (komunikat o błędzie startu)

// Informacja o urządzeniu AI – PyTorch wczytuje się w tle po starcie, więc przez chwilę urządzenie nie jest znane
async function showDevice() {
  try {
    const s = await (await fetch('/api/status')).json();
    const chip = $('device');
    const ai = !s.device ? t('AI: sprawdzanie…') : s.device === 'cuda' ? t('AI: GPU – {name}', { name: s.deviceName }) : t('AI: procesor');
    chip.textContent = `v${s.version} · ${ai}`;
    chip.parentElement.classList.toggle('gpu', s.device === 'cuda');
    if (!s.device) setTimeout(showDevice, 1500);
  } catch {
    $('device').textContent = t('serwer niedostępny');
  }
}
showDevice();
