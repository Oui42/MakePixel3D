// Presety stylu (jedno kliknięcie zamiast wielu suwaków) + zapamiętywanie ustawień między uruchomieniami.
// Klucze obiektów = id pól formularza w index.html.

export const PRESETS = {
  rpg: {
    name: 'Postać RPG – 32×48, stopy na dole',
    values: { size: '32', aspect: '1.5', anchor: 'ground', pitch: '30', dirCount: '8', paletteMode: 'auto',
      colors: '16', dither: '0', sampling: 'sharp', outline: 'auto', saturation: '125', contrast: '115', zoom: '100' },
  },
  pico: {
    name: 'Retro PICO-8 – 16 px',
    values: { size: '16', aspect: '1', anchor: 'ground', pitch: '30', dirCount: '4', paletteMode: 'pico8',
      dither: '0', sampling: 'sharp', outline: 'auto', saturation: '140', contrast: '120', zoom: '100' },
  },
  iso: {
    name: 'Budynek izometryczny – 64 px',
    values: { size: '64', aspect: '1', anchor: 'ground', pitch: '30', dirCount: '4', paletteMode: 'auto',
      colors: '24', dither: '0', sampling: 'avg', outline: 'auto', saturation: '115', contrast: '110', zoom: '100' },
  },
  icon: {
    name: 'Ikona przedmiotu – 32 px',
    values: { size: '32', aspect: '1', anchor: 'center', pitch: '20', dirCount: '8', paletteMode: 'auto',
      colors: '16', dither: '0', sampling: 'sharp', outline: 'color', outlineColor: '#1b1026',
      saturation: '135', contrast: '115', zoom: '100' },
  },
  gameboy: {
    name: 'Game Boy – 32 px, dithering',
    values: { size: '32', aspect: '1', anchor: 'ground', pitch: '30', dirCount: '8', paletteMode: 'gameboy',
      dither: '40', sampling: 'avg', outline: 'auto', saturation: '100', contrast: '110', zoom: '100' },
  },
  detailed: {
    name: 'Szczegółowy – 128 px',
    values: { size: '128', aspect: '1', anchor: 'center', pitch: '30', dirCount: '8', paletteMode: 'auto',
      colors: '48', dither: '0', sampling: 'avg', outline: 'auto', saturation: '115', contrast: '105', zoom: '100' },
  },
};

// Pola zapamiętywane między uruchomieniami (bez korekt konkretnego modelu, np. obrotu „przodu”)
export const SAVED_FIELDS = [
  'objectKind', 'armsDown', 'removeBg', 'quality', 'symmetry', 'voxelMode', 'voxelRes', 'dirCount', 'pitch', 'zoom', 'anchor', 'size', 'aspect', 'sampling',
  'paletteMode', 'colors', 'dither', 'saturation', 'contrast', 'brightness', 'threshold', 'outline',
  'outlineColor', 'shadowOpacity', 'shadowColorMode', 'shadowColor', 'lighting', 'matchPhoto', 'removeOrphans', 'exportScale', 'animFrames', 'gifDuration',
];

const KEY = 'pixelforge.settings.v1';

// localStorage może być niedostępny (tryb prywatny, zablokowane dane) – wtedy po prostu nie zapamiętujemy
export function loadSaved() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export function save(values) {
  try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* brak zapisu – trudno */ }
}

export function clearSaved() {
  try { localStorage.removeItem(KEY); } catch { /* j.w. */ }
}

// Własna paleta (wczytana z pliku) – zapamiętana osobno jako lista kolorów [r, g, b]
const PALETTE_KEY = 'pixelforge.customPalette.v1';

export function loadCustomPalette() {
  try {
    const p = JSON.parse(localStorage.getItem(PALETTE_KEY) || 'null');
    return p && Array.isArray(p.colors) && p.colors.length ? p : null;
  } catch { return null; }
}

export function saveCustomPalette(palette) {
  try { localStorage.setItem(PALETTE_KEY, JSON.stringify(palette)); } catch { /* j.w. */ }
}
