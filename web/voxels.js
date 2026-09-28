// Tryb wokselowy: model 3D → siatka sześcianów („klocki” jak w Minecrafcie).
// Powierzchnię modelu próbkujemy równomiernie (liczba próbek zależy od pola trójkąta), każdy trafiony woksel
// dostaje średni kolor próbek. Wystarczy sama „skorupa” – wnętrza i tak nie widać.
// Wynik rysujemy jako InstancedMesh: jedna kostka × tysiące instancji, kolor per instancja.
import * as THREE from 'three';

// Stała jasność ścian kostki – klasyczny wygląd wokseli niezależny od oświetlenia.
// Kolejność ścian w BoxGeometry: +x, −x, +y (góra), −y (spód), +z, −z.
const FACE_SHADE = [0.8, 0.8, 1.0, 0.55, 0.9, 0.9];
let cubeGeometry = null;

function cube() {
  if (cubeGeometry) return cubeGeometry;
  const g = new THREE.BoxGeometry(1, 1, 1);
  const n = g.attributes.position.count;   // 6 ścian × 4 wierzchołki
  const col = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) col.fill(FACE_SHADE[Math.floor(v / 4)], v * 3, v * 3 + 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return (cubeGeometry = g);
}

export function voxelMaterial(lit) {
  // kolor końcowy = jasność ściany (kolor wierzchołka) × kolor woksela (instanceColor)
  return lit ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new THREE.MeshBasicMaterial({ vertexColors: true });
}

/**
 * @param meshes siatki modelu (z aktualnymi matrixWorld) – wokselizacja w układzie świata
 * @param res    liczba wokseli na najdłuższym boku modelu
 * @returns { centers, colors, count, size } albo null
 */
export function voxelize(meshes, res) {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  if (box.isEmpty()) return null;
  const ext = box.getSize(new THREE.Vector3());
  const size = Math.max(ext.x, ext.y, ext.z) / res;
  const nx = Math.max(1, Math.ceil(ext.x / size)), ny = Math.max(1, Math.ceil(ext.y / size)), nz = Math.max(1, Math.ceil(ext.z / size));
  const acc = new Map();   // indeks woksela → [r, g, b, liczba próbek]

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), p = new THREE.Vector3();
  const ids = [0, 0, 0];
  for (const mesh of meshes) {
    const g = mesh.geometry, P = g.attributes.position, C = g.attributes.color, index = g.index;
    const base = mesh.material?.color ?? new THREE.Color(0.8, 0.8, 0.8);
    const col = (i) => (C ? [C.getX(i), C.getY(i), C.getZ(i)] : [base.r, base.g, base.b]);
    const tris = (index ? index.count : P.count) / 3;
    for (let t = 0; t < tris; t++) {
      for (let k = 0; k < 3; k++) ids[k] = index ? index.getX(t * 3 + k) : t * 3 + k;
      a.fromBufferAttribute(P, ids[0]).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(P, ids[1]).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(P, ids[2]).applyMatrix4(mesh.matrixWorld);
      const area = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
      const samples = Math.min(256, Math.max(1, Math.ceil((area / (size * size)) * 6)));
      const ca = col(ids[0]), cb = col(ids[1]), cc = col(ids[2]);
      for (let s = 0; s < samples; s++) {
        // równomierne, powtarzalne punkty na trójkącie (ten sam model = te same woksele)
        const r1 = Math.sqrt((s + 0.5) / samples), r2 = (s * 0.6180339887) % 1;
        const wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
        p.set(a.x * wa + b.x * wb + c.x * wc, a.y * wa + b.y * wb + c.y * wc, a.z * wa + b.z * wb + c.z * wc);
        const x = Math.min(nx - 1, Math.floor((p.x - box.min.x) / size));
        const y = Math.min(ny - 1, Math.floor((p.y - box.min.y) / size));
        const z = Math.min(nz - 1, Math.floor((p.z - box.min.z) / size));
        const key = (x * ny + y) * nz + z;
        let v = acc.get(key);
        if (!v) acc.set(key, (v = [0, 0, 0, 0]));
        v[0] += ca[0] * wa + cb[0] * wb + cc[0] * wc;
        v[1] += ca[1] * wa + cb[1] * wb + cc[1] * wc;
        v[2] += ca[2] * wa + cb[2] * wb + cc[2] * wc;
        v[3]++;
      }
    }
  }

  const count = acc.size;
  const centers = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  let i = 0;
  for (const [key, v] of acc) {
    const z = key % nz, y = Math.floor(key / nz) % ny, x = Math.floor(key / (ny * nz));
    centers[i * 3] = box.min.x + (x + 0.5) * size;
    centers[i * 3 + 1] = box.min.y + (y + 0.5) * size;
    centers[i * 3 + 2] = box.min.z + (z + 0.5) * size;
    colors[i * 3] = v[0] / v[3]; colors[i * 3 + 1] = v[1] / v[3]; colors[i * 3 + 2] = v[2] / v[3];
    i++;
  }
  return { centers, colors, count, size };
}

export function buildVoxelMesh(data, material) {
  const mesh = new THREE.InstancedMesh(cube(), material, data.count);
  const m = new THREE.Matrix4(), color = new THREE.Color();
  for (let i = 0; i < data.count; i++) {
    m.makeScale(data.size, data.size, data.size).setPosition(data.centers[i * 3], data.centers[i * 3 + 1], data.centers[i * 3 + 2]);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color.setRGB(data.colors[i * 3], data.colors[i * 3 + 1], data.colors[i * 3 + 2]));
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Narożniki wokseli (próbka) – do liczenia kadru, tak jak wierzchołki zwykłego modelu. */
export function voxelFitPoints(data, maxPoints = 40000) {
  const out = [];
  const h = data.size / 2;
  const step = Math.max(1, Math.floor((data.count * 8) / maxPoints));
  let n = 0;
  for (let i = 0; i < data.count; i++) {
    const cx = data.centers[i * 3], cy = data.centers[i * 3 + 1], cz = data.centers[i * 3 + 2];
    for (const dx of [-h, h]) for (const dy of [-h, h]) for (const dz of [-h, h]) {
      if (n++ % step === 0) out.push(cx + dx, cy + dy, cz + dz);
    }
  }
  return out;
}
