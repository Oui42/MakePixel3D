import { t, locale } from './i18n.js';

// Galeria / historia: lista modeli zapisanych przez serwer w folderze library/.
// Każdy wygenerowany model trafia tam automatycznie (zdjęcie z maską + model .glb + miniatura).

export async function listEntries() {
  const res = await fetch('/api/library');
  if (!res.ok) throw new Error(t('galeria niedostępna ({status})', { status: res.status }));
  return res.json();
}

// ?v= – po zapisie miniatura ma nowy adres, więc przeglądarka nie pokaże starej z pamięci
export const fileUrl = (entry, name) => `/api/library/${entry.id}/${name}?v=${entry.updated ?? entry.created}`;

async function send(url, method, form) {
  const res = await fetch(url, { method, body: form });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).detail ?? msg; } catch { /* odpowiedź bez JSON */ }
    throw new Error(msg);
  }
  return res.json();
}

/** Nowy wpis dla modelu spoza galerii (np. wczytanego z pliku .glb). Zwraca id. */
export async function createEntry(modelBlob, sourceBlob, thumbBlob, name, kind = null) {
  const form = new FormData();
  form.append('model', modelBlob, 'model.glb');
  if (sourceBlob) form.append('source', sourceBlob, 'source.png');
  if (thumbBlob) form.append('thumb', thumbBlob, 'thumb.png');
  form.append('name', name);
  if (kind) form.append('kind', kind);
  return (await send('/api/library', 'POST', form)).id;
}

/** „Zapisz w galerii”: stan pracy (JSON) + poprawione zdjęcie + miniatura z pixel-artem. */
export async function saveProject(entryId, project, sourceBlob, thumbBlob, modelBlob = null, modelName = 'model.glb') {
  const form = new FormData();
  form.append('project', new Blob([JSON.stringify(project)], { type: 'application/json' }), 'project.json');
  if (sourceBlob) form.append('source', sourceBlob, 'source.png');
  if (thumbBlob) form.append('thumb', thumbBlob, 'thumb.png');
  if (modelBlob) { form.append('model', modelBlob, modelName); form.append('model_name', modelName); }   // S11: przemalowany model
  return send(`/api/library/${entryId}/project`, 'PUT', form);
}

/** Zapisany stan pracy albo null (wpis nigdy nie był zapisywany ręcznie). */
export async function fetchProject(entry) {
  if (!entry.hasProject) return null;
  const res = await fetch(fileUrl(entry, 'project.json'));
  return res.ok ? res.json() : null;
}

export async function fetchFile(entry, name) {
  const res = await fetch(fileUrl(entry, name));
  if (!res.ok) throw new Error(t('brak pliku {name} w galerii', { name }));
  return res.blob();
}

export async function renameEntry(entry, name) {
  const form = new FormData();
  form.append('name', name);
  const res = await fetch(`/api/library/${entry.id}`, { method: 'PATCH', body: form });
  if (!res.ok) throw new Error(t('nie udało się zmienić nazwy'));
  return res.json();
}

export async function deleteEntry(entry) {
  const res = await fetch(`/api/library/${entry.id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(t('nie udało się usunąć'));
}

export function formatDate(seconds) {
  return new Date(seconds * 1000).toLocaleString(locale(), {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Kafelki galerii. actions: { open(entry), rename?(entry), remove?(entry) } – bez rename/remove = wersja skrócona
 * (ekran startowy: sam kafelek jest przyciskiem „otwórz”).
 */
export function renderTiles(container, entries, actions) {
  container.replaceChildren(...entries.map((entry) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const img = document.createElement('img');
    img.src = fileUrl(entry, 'thumb.png');
    img.alt = '';
    img.className = 'checker';
    img.loading = 'lazy';
    const name = document.createElement('b');
    name.textContent = entry.name;
    name.title = entry.name;
    const meta = document.createElement('small');
    meta.textContent = entry.updated ? t('zapisano {date}', { date: formatDate(entry.updated) }) : formatDate(entry.created);
    meta.title = t('jakość {q} · {s} s · {device}', { q: entry.quality ?? '?', s: entry.seconds ?? '?', device: entry.device ?? '' });

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tile-open';
    open.append(img, name, meta);
    open.title = t('Otwórz „{name}”', { name: entry.name });
    open.addEventListener('click', () => actions.open(entry));
    tile.append(open);

    if (actions.rename || actions.remove) {
      const bar = document.createElement('div');
      bar.className = 'tile-actions';
      if (actions.rename) bar.append(button(t('Zmień nazwę'), () => actions.rename(entry)));
      if (actions.remove) bar.append(button(t('Usuń'), () => actions.remove(entry), 'danger'));
      tile.append(bar);
    }
    return tile;
  }));
}

function button(text, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}
