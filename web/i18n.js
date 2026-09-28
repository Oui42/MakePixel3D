// Wersje językowe interfejsu.
// Teksty źródłowe (w HTML i w kodzie) są po polsku; słownik lang/en.js tłumaczy je na angielski.
// - Statyczny HTML: translateDom() podmienia węzły tekstowe i atrybuty (title, aria-label, data-label…),
//   pamiętając oryginał – dzięki temu można przełączać język tam i z powrotem bez przeładowania strony.
// - Teksty wstawiane z kodu: t('Tekst {x}', { x }) – klucz to polski tekst z {nazwami} parametrów.
// Nowy tekst w interfejsie = dopisz tłumaczenie do lang/en.js (brak tłumaczenia → zostaje polski tekst).
// Nowy język = nowy plik lang/xx.js z tymi samymi kluczami + wpis w DICTS i w ustawieniach (serwer: settings.LANGUAGES).
import { EN } from './lang/en.js';

const DICTS = { en: EN };
let lang = 'en';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

export const getLang = () => lang;
export const locale = () => (lang === 'pl' ? 'pl-PL' : 'en-GB');

export function setLang(value) {
  lang = value === 'pl' ? 'pl' : 'en';
  document.documentElement.lang = lang;
}

/** Tekst w bieżącym języku; {nazwa} w tekście zastępowane wartościami z params. */
export function t(text, params) {
  let s = lang === 'pl' ? text : (DICTS[lang]?.[text] ?? text);
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}

function translated(original) {
  const key = norm(original);
  if (!key || lang === 'pl') return original;
  const value = DICTS[lang]?.[key];
  if (!value) return original;
  // zachowujemy spacje na brzegach (np. „Pochylenie ” przed <output>)
  return original.match(/^\s*/)[0] + value + original.match(/\s*$/)[0];
}

const ATTRS = ['title', 'aria-label', 'placeholder', 'data-title', 'data-label', 'data-sub', 'alt'];
const textOriginals = new WeakMap();
const attrOriginals = new WeakMap();

/** Tłumaczy statyczne teksty i atrybuty w podanym fragmencie strony (domyślnie cała strona). */
export function translateDom(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!textOriginals.has(node)) textOriginals.set(node, node.nodeValue);
    const next = translated(textOriginals.get(node));
    if (node.nodeValue !== next) node.nodeValue = next;
  }
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of ATTRS) {
      if (!el.hasAttribute?.(attr)) continue;
      let saved = attrOriginals.get(el);
      if (!saved) attrOriginals.set(el, (saved = {}));
      if (!(attr in saved)) saved[attr] = el.getAttribute(attr);
      const next = translated(saved[attr]);
      if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
    }
  }
}
