// S10: szkielet i animacje. Model ze szkieletem (UniRig → GLB z SkinnedMesh) dostaje PROCEDURALNE klipy animacji:
// dla postaci humanoidalnych (kości nazwane po VRoid: J_Bip_…) – bezruch, chód, bieg, atak; dla innych obiektów
// (kości bone_N bez znaczenia) – kołysanie i podskok całej bryły. Klipy to zwykłe THREE.AnimationClip, więc podgląd
// 3D gra je przez AnimationMixer, a sprite'y renderujemy w wybranych chwilach (mixer.setTime).
import * as THREE from 'three';

const V = {   // nazwy kości VRoid, których używają klipy
  hips: 'J_Bip_C_Hips', spine: 'J_Bip_C_Spine', chest: 'J_Bip_C_Chest', neck: 'J_Bip_C_Neck', head: 'J_Bip_C_Head',
  lUpperArm: 'J_Bip_L_UpperArm', lLowerArm: 'J_Bip_L_LowerArm', rUpperArm: 'J_Bip_R_UpperArm', rLowerArm: 'J_Bip_R_LowerArm',
  lUpperLeg: 'J_Bip_L_UpperLeg', lLowerLeg: 'J_Bip_L_LowerLeg', rUpperLeg: 'J_Bip_R_UpperLeg', rLowerLeg: 'J_Bip_R_LowerLeg',
  lFoot: 'J_Bip_L_Foot', rFoot: 'J_Bip_R_Foot',
};

/** Szkielet w modelu: siatki skórowane, kości, czy to humanoid (nazwy VRoid). null = model bez szkieletu. */
export function findRig(root) {
  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) return null;
  const bones = skinned[0].skeleton.bones;
  const byName = new Map(bones.map((b) => [b.name, b]));
  const humanoid = byName.has(V.hips) && (byName.has(V.lUpperLeg) || byName.has(V.lUpperArm));
  const roots = bones.filter((b) => !b.parent?.isBone);
  // wysokość modelu (jednostki modelu) – do przesunięć w klipach ogólnych
  const box = new THREE.Box3();
  for (const m of skinned) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
  const height = box.getSize(new THREE.Vector3()).y || 1;
  return { skinned, bones, byName, humanoid, roots, height, rest: snapshotRest(bones) };
}

function snapshotRest(bones) {
  return new Map(bones.map((b) => [b.name, { q: b.quaternion.clone(), p: b.position.clone() }]));
}

/** Przywrócenie pozy spoczynkowej (po zatrzymaniu animacji sprite'y mają wracać do modelu bez pozy). */
export function resetPose(rig) {
  for (const b of rig.bones) {
    const r = rig.rest.get(b.name);
    if (r) { b.quaternion.copy(r.q); b.position.copy(r.p); }
  }
}

export function clipNames(rig) {
  return rig.humanoid ? ['idle', 'walk', 'run', 'attack'] : ['sway', 'bounce'];
}

// ---------- budowanie klipów ----------
const deg = THREE.MathUtils.degToRad;

/** Ścieżka obrotu kości: kąty (stopnie) wokół lokalnych osi w kolejnych chwilach; wynik = obrót spoczynkowy × delta. */
function rotTrack(rig, name, times, angles) {
  const bone = rig.byName.get(name);
  if (!bone) return null;
  const rest = rig.rest.get(name).q;
  const values = [];
  const e = new THREE.Euler(), q = new THREE.Quaternion();
  for (const [x, y, z] of angles) {
    e.set(deg(x), deg(y), deg(z));
    q.copy(rest).multiply(new THREE.Quaternion().setFromEuler(e));
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values);
}

function posTrack(rig, name, times, offsets) {
  const bone = rig.byName.get(name);
  if (!bone) return null;
  const rest = rig.rest.get(name).p;
  const values = [];
  for (const [x, y, z] of offsets) values.push(rest.x + x, rest.y + y, rest.z + z);
  return new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values);
}

/** Sinusoida: wartość amp·sin(2π·t/period + phase) próbkowana w n punktach na okres (pełna pętla). */
function wave(n, period, amp, phase = 0) {
  const times = [], vals = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * period;
    times.push(t);
    vals.push(amp * Math.sin((2 * Math.PI * i) / n + phase));
  }
  return { times, vals };
}

function humanoidCycle(rig, period, legAmp, armAmp, bob, kneeAmp) {
  const n = 16;
  const { times, vals: s } = wave(n, period, 1);
  const tracks = [
    rotTrack(rig, V.lUpperLeg, times, s.map((v) => [legAmp * v, 0, 0])),
    rotTrack(rig, V.rUpperLeg, times, s.map((v) => [-legAmp * v, 0, 0])),
    // kolano ugina się, gdy noga idzie do tyłu (tylko dodatnie zgięcie)
    rotTrack(rig, V.lLowerLeg, times, s.map((v) => [kneeAmp * Math.max(0, -v), 0, 0])),
    rotTrack(rig, V.rLowerLeg, times, s.map((v) => [kneeAmp * Math.max(0, v), 0, 0])),
    rotTrack(rig, V.lUpperArm, times, s.map((v) => [-armAmp * v, 0, 0])),
    rotTrack(rig, V.rUpperArm, times, s.map((v) => [armAmp * v, 0, 0])),
    rotTrack(rig, V.spine, times, s.map((v) => [0, 4 * v, 0])),
    // biodra podskakują dwa razy na cykl (przy każdym kroku)
    posTrack(rig, V.hips, times, s.map((_, i) => [0, bob * rig.height * Math.abs(Math.sin((2 * Math.PI * i) / n)), 0])),
  ];
  return tracks.filter(Boolean);
}

export function buildClip(rig, name) {
  let tracks = [], duration = 1;
  if (name === 'idle') {
    duration = 2.4;
    const { times, vals: s } = wave(16, duration, 1);
    tracks = [
      rotTrack(rig, V.chest, times, s.map((v) => [2 * v, 0, 0])),
      rotTrack(rig, V.head, times, s.map((v) => [-1.5 * v, 0, 0])),
      rotTrack(rig, V.lUpperArm, times, s.map((v) => [0, 0, 2 * v])),
      rotTrack(rig, V.rUpperArm, times, s.map((v) => [0, 0, -2 * v])),
      posTrack(rig, V.hips, times, s.map((v) => [0, 0.006 * rig.height * v, 0])),
    ].filter(Boolean);
  } else if (name === 'walk') {
    duration = 1.0;
    tracks = humanoidCycle(rig, duration, 28, 22, 0.015, 25);
  } else if (name === 'run') {
    duration = 0.6;
    tracks = humanoidCycle(rig, duration, 45, 40, 0.035, 55);
    const lean = rotTrack(rig, V.spine, [0, duration], [[12, 0, 0], [12, 0, 0]]);
    tracks = tracks.filter((t) => !t.name.startsWith(`${V.spine}.`)).concat(lean ? [lean] : []);
  } else if (name === 'attack') {
    duration = 0.8;
    // zamach prawą ręką: uniesienie (0–0,35 s), cios (0,35–0,5 s), powrót
    const times = [0, 0.35, 0.5, 0.8];
    tracks = [
      rotTrack(rig, V.rUpperArm, times, [[0, 0, 0], [-110, 0, -35], [40, 0, -10], [0, 0, 0]]),
      rotTrack(rig, V.rLowerArm, times, [[0, 0, 0], [-60, 0, 0], [-10, 0, 0], [0, 0, 0]]),
      rotTrack(rig, V.spine, times, [[0, 0, 0], [0, -20, 0], [8, 25, 0], [0, 0, 0]]),
      rotTrack(rig, V.lUpperArm, times, [[0, 0, 0], [25, 0, 0], [-20, 0, 0], [0, 0, 0]]),
      rotTrack(rig, V.lUpperLeg, times, [[0, 0, 0], [-15, 0, 0], [20, 0, 0], [0, 0, 0]]),
      rotTrack(rig, V.rUpperLeg, times, [[0, 0, 0], [15, 0, 0], [-25, 0, 0], [0, 0, 0]]),
    ].filter(Boolean);
  } else if (name === 'sway') {
    duration = 2.0;
    const { times, vals: s } = wave(16, duration, 1);
    tracks = rig.roots.map((b) => rotTrack(rig, b.name, times, s.map((v) => [0, 0, 6 * v])));
  } else if (name === 'bounce') {
    duration = 0.8;
    const n = 16, times = [], offs = [];
    for (let i = 0; i <= n; i++) {
      times.push((i / n) * duration);
      offs.push([0, 0.08 * rig.height * Math.abs(Math.sin((Math.PI * i) / n)), 0]);
    }
    tracks = rig.roots.map((b) => posTrack(rig, b.name, times, offs));
  }
  tracks = tracks.filter(Boolean);
  if (!tracks.length) return null;
  return new THREE.AnimationClip(name, duration, tracks);
}

/** Etykiety klipów (polskie źródło – tłumaczy i18n). */
export const CLIP_LABELS = {
  none: 'Bez animacji', idle: 'Bezruch', walk: 'Chód', run: 'Bieg', attack: 'Atak', sway: 'Kołysanie', bounce: 'Podskok',
};
