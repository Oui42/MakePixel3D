// Przyciski wyboru zamiast list rozwijanych.
// Źródłem prawdy zostaje ukryty <select data-seg> – dzięki temu działają bez zmian: .value, zdarzenia 'input',
// zapamiętywanie ustawień, presety i blokowanie (.disabled). Przyciski tylko go odzwierciedlają.
// Napis na przycisku: data-label opcji (albo jej tekst), mały podpis: data-sub, podpowiedź: title.

export function initSegmented(root = document) {
  for (const select of root.querySelectorAll('select[data-seg]')) build(select);
}

function build(select) {
  const group = document.createElement('div');
  group.className = 'seg';
  group.setAttribute('role', 'radiogroup');
  const label = select.id && document.querySelector(`label[for="${select.id}"]`);
  if (label) group.setAttribute('aria-label', label.textContent.trim());
  select.after(group);
  select.closest('.row')?.classList.add('stack');   // etykieta nad przyciskami – mieszczą się w wąskim panelu

  const render = () => {
    group.replaceChildren(...[...select.options].map((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = opt.value;
      b.textContent = opt.dataset.label ?? opt.text;
      if (opt.dataset.sub) {
        const small = document.createElement('small');
        small.textContent = opt.dataset.sub;
        b.append(small);
      }
      b.title = opt.title || opt.text;
      b.addEventListener('click', () => {
        if (select.value === opt.value) return;
        select.value = opt.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return b;
    }));
    sync();
  };

  const sync = () => {
    for (const b of group.children) {
      b.setAttribute('aria-checked', String(b.dataset.value === select.value));
      b.disabled = select.disabled;
    }
  };

  // Kod ustawia .value / .disabled bezpośrednio (presety, zapamiętane ustawienia, blokada) – przechwytujemy to,
  // żeby przyciski zawsze pokazywały aktualny stan.
  for (const prop of ['value', 'disabled']) {
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), prop)
      ?? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { proto.set.call(this, v); sync(); },
    });
  }
  select.addEventListener('input', sync);
  // zmiana treści opcji (np. „Jak kierunki” z podpisem liczby) → przerysowanie przycisków
  new MutationObserver(render).observe(select, { subtree: true, childList: true, characterData: true, attributes: true });
  render();
}

/** Podświetla przycisk skrótu (np. pochylenie 0° / 30° / 45° / 90°), gdy suwak ma dokładnie jego wartość. */
export function syncShortcutButtons(container, value) {
  for (const b of container.querySelectorAll('button[data-v]')) {
    b.setAttribute('aria-checked', String(b.dataset.v === String(value)));
  }
}
