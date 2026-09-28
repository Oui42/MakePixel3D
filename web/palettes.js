// Gotowe palety pixel-artu + wczytywanie własnych (.hex z Lospec, .gpl z GIMP/Aseprite, obraz PNG).
// `luma: true` – paleta jednobarwna (odcienie jednego koloru): mapujemy po jasności, a nie po kolorze.

const hex = (list) => list.map((h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);

export const PALETTES = {
  pico8: {
    name: 'PICO-8 (16)',
    colors: hex(['000000', '1d2b53', '7e2553', '008751', 'ab5236', '5f574f', 'c2c3c7', 'fff1e8',
      'ff004d', 'ffa300', 'ffec27', '00e436', '29adff', '83769c', 'ff77a8', 'ffccaa']),
  },
  sweetie16: {
    name: 'Sweetie 16',
    colors: hex(['1a1c2c', '5d275d', 'b13e53', 'ef7d57', 'ffcd75', 'a7f070', '38b764', '257179',
      '29366f', '3b5dc9', '41a6f6', '73eff7', 'f4f4f4', '94b0c2', '566c86', '333c57']),
  },
  endesga32: {
    name: 'Endesga 32',
    colors: hex(['be4a2f', 'd77643', 'ead4aa', 'e4a672', 'b86f50', '733e39', '3e2731', 'a22633',
      'e43b44', 'f77622', 'feae34', 'fee761', '63c74d', '3e8948', '265c42', '193c3e',
      '124e89', '0099db', '2ce8f5', 'ffffff', 'c0cbdc', '8b9bb4', '5a6988', '3a4466',
      '262b44', '181425', 'ff0044', '68386c', 'b55088', 'f6757a', 'e8b796', 'c28569']),
  },
  gameboy: {
    name: 'Game Boy (4 zielenie)',
    colors: hex(['0f380f', '306230', '8bac0f', '9bbc0f']),
    luma: true,
  },
  gray4: {
    name: 'Szarości (4)',
    colors: hex(['000000', '555555', 'aaaaaa', 'ffffff']),
    luma: true,
  },
  mono: {
    name: '1-bit (czarno-biała)',
    colors: hex(['000000', 'ffffff']),
    luma: true,
  },
};

/** Tekst palety: .hex (RRGGBB w wierszu), .gpl („R G B nazwa”) albo dowolne #RRGGBB w tekście. */
export function parsePaletteText(text) {
  const colors = [];
  const gpl = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\b/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(gpl);
    if (m) { colors.push([+m[1], +m[2], +m[3]].map((v) => Math.min(255, v))); continue; }
    for (const h of line.matchAll(/#?\b([0-9a-f]{6})\b/gi)) colors.push(hex([h[1]])[0]);
  }
  return dedupe(colors).slice(0, 256);
}

/** Paleta z obrazka (np. pasek kolorów z Lospec) – unikalne kolory nieprzezroczystych pikseli. */
export function paletteFromImage(imageData) {
  const d = imageData.data, colors = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 127) colors.push([d[i], d[i + 1], d[i + 2]]);
  return dedupe(colors).slice(0, 256);
}

function dedupe(colors) {
  const seen = new Set();
  return colors.filter(([r, g, b]) => {
    const k = (r << 16) | (g << 8) | b;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
