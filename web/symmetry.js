// Symetria lewa–prawa: zostawiamy połowę modelu i dokładamy jej lustrzane odbicie.
// Model AI często ma krzywe boki (zgaduje niewidoczne części) – symetria je wyrównuje.
// Płaszczyzna symetrii: x = 0 w układzie świata (po obrocie „przodu”), czyli środek modelu widziany z przodu.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * @param meshes  siatki modelu (z aktualnymi matrixWorld)
 * @param keep    'left' – wzorem jest lewa połowa (na zdjęciu), 'right' – prawa
 * @returns BufferGeometry w układzie świata albo null, gdy nic nie zostało
 */
export function buildSymmetricGeometry(meshes, keep) {
  const pos = [], col = [], uv = [];
  const withColor = meshes.every((m) => m.geometry.attributes.color);
  const withUv = !withColor && meshes.every((m) => m.geometry.attributes.uv);
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ids = [0, 0, 0];

  for (const mesh of meshes) {
    const g = mesh.geometry, P = g.attributes.position, C = g.attributes.color, U = g.attributes.uv;
    const index = g.index;
    const tris = (index ? index.count : P.count) / 3;
    for (let t = 0; t < tris; t++) {
      for (let k = 0; k < 3; k++) {
        ids[k] = index ? index.getX(t * 3 + k) : t * 3 + k;
        p[k].fromBufferAttribute(P, ids[k]).applyMatrix4(mesh.matrixWorld);
      }
      const cx = (p[0].x + p[1].x + p[2].x) / 3;
      // „lewa” na zdjęciu = −X (kamera z przodu patrzy wzdłuż −Z)
      if (keep === 'left' ? cx > 0 : cx < 0) continue;
      // oryginalny trójkąt + odbity (odwrócona kolejność wierzchołków, żeby normalne wskazywały na zewnątrz)
      for (const [k, mirror] of [[0, 1], [1, 1], [2, 1], [0, -1], [2, -1], [1, -1]]) {
        pos.push(p[k].x * mirror, p[k].y, p[k].z);
        if (withColor) col.push(C.getX(ids[k]), C.getY(ids[k]), C.getZ(ids[k]));
        if (withUv) uv.push(U.getX(ids[k]), U.getY(ids[k]));
      }
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (withColor) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (withUv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // scalenie wspólnych wierzchołków → gładkie cieniowanie zamiast „kanciastych” trójkątów
  const merged = mergeVertices(geo);
  merged.computeVertexNormals();
  return merged;
}
