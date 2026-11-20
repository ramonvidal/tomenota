// Menu de ações "⋯". No computador abre ao lado do botão; no celular sobe da parte de baixo da tela.
export function createMenu(h) {
  let box = null;
  let backdrop = null;

  function close() {
    box?.remove(); backdrop?.remove();
    box = backdrop = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
  }
  function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); } }
  function onScroll(ev) { if (box && !box.contains(ev.target)) close(); }

  const isSheet = () => window.matchMedia('(max-width: 520px)').matches;

  function place(anchor) {
    if (isSheet()) return;
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth, hgt = box.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = r.bottom + 4;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 4);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  // build(api) devolve os itens; api.set(...itens) troca o conteúdo (submenus).
  function open(anchor, build) {
    close();
    box = h('div', { class: 'menu' + (isSheet() ? ' sheet' : ''), role: 'menu' });
    backdrop = h('div', { class: 'menu-backdrop' + (isSheet() ? ' dim' : ''), onclick: close });
    const api = {
      close,
      set: (...items) => { box.replaceChildren(...items.flat().filter(Boolean)); place(anchor); box.querySelector('button, input')?.focus(); },
    };
    document.body.append(backdrop, box);
    api.set(build(api));
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
  }

  // Item clicável. O menu fecha antes da ação, exceto em submenus (keepOpen).
  function item(label, fn, { danger = false, hint = '', keepOpen = false } = {}) {
    return h('button', {
      type: 'button', role: 'menuitem', class: 'menu-item' + (danger ? ' danger' : ''),
      onclick: () => { if (!keepOpen) close(); fn(); },
    }, h('span', {}, label), hint ? h('span', { class: 'menu-hint' }, hint) : null);
  }
  const sep = () => h('div', { class: 'menu-sep', role: 'separator' });
  const title = (t) => h('div', { class: 'menu-title' }, t);

  return { open, close, item, sep, title };
}
