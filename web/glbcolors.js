// S11: zapis zmienionych kolorów wierzchołków z powrotem do pliku GLB (bez GLTFExporter – ten przebudowałby cały plik,
// łącznie ze szkieletem i wagami skórowania). Podmieniamy TYLKO bajty akcesora COLOR_0 w kawałku binarnym; resztę pliku
// (siatka, kości, JSON) kopiujemy bez zmian. Mapowanie obiekt Three.js → prymityw glTF daje `parser.associations`.
const MAGIC = 0x46546c67;   // 'glTF'
const CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENTS = { 5126: 4, 5121: 1, 5123: 2 };   // float32, uint8, uint16 – tylko takie mogą być w COLOR_0
const N_COMP = { VEC3: 3, VEC4: 4 };

/**
 * @param buffer ArrayBuffer oryginalnego GLB
 * @param parser gltf.parser z GLTFLoader (associations)
 * @param meshes siatki Three.js, których atrybut `color` ma trafić do pliku
 * @returns nowy ArrayBuffer (kopia z podmienionymi kolorami); rzuca, gdy pliku nie da się zaktualizować
 */
export function patchGlbColors(buffer, parser, meshes) {
  const out = buffer.slice(0);
  const dv = new DataView(out);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a GLB');
  const total = dv.getUint32(8, true);
  let p = 12, json = null, binStart = -1;
  while (p < total) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(out, p + 8, len)));
    else if (type === CHUNK_BIN && binStart < 0) binStart = p + 8;
    p += 8 + len;
  }
  if (!json || binStart < 0) throw new Error('GLB without JSON/BIN chunk');
  let written = 0;
  for (const mesh of meshes) {
    const assoc = parser.associations.get(mesh);
    const color = mesh.geometry.attributes.color;
    if (!assoc || assoc.meshes === undefined || assoc.primitives === undefined || !color) continue;
    const prim = json.meshes[assoc.meshes]?.primitives[assoc.primitives];
    const accIndex = prim?.attributes?.COLOR_0;
    if (accIndex === undefined) continue;
    const acc = json.accessors[accIndex];
    if (acc.sparse || acc.bufferView === undefined) continue;
    const bv = json.bufferViews[acc.bufferView];
    if ((bv.buffer ?? 0) !== 0) continue;   // kolory w osobnym pliku .bin – nie w GLB
    const size = COMPONENTS[acc.componentType], ncomp = N_COMP[acc.type];
    if (!size || !ncomp || acc.count !== color.count) continue;
    const stride = bv.byteStride || size * ncomp;
    const base = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    for (let i = 0; i < acc.count; i++) {
      const at = base + i * stride;
      for (let ch = 0; ch < 3; ch++) {   // alfa (VEC4) zostaje, jak była
        const v = Math.min(1, Math.max(0, color.getComponent(i, ch)));
        const o = at + ch * size;
        if (acc.componentType === 5126) dv.setFloat32(o, v, true);
        else if (acc.componentType === 5121) dv.setUint8(o, Math.round(v * 255));
        else dv.setUint16(o, Math.round(v * 65535), true);
      }
    }
    written++;
  }
  if (!written) throw new Error('no COLOR_0 to update');
  return out;
}
