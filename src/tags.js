// Índice de #tags (diário + notas) e sugestões enquanto você digita "#…".
import { normalizeTag } from './parse.js';

const TOKEN_RE = /(^|\s)#([\p{L}\p{N}_-]*)$/u;

export function createTags({ store, h }) {
  let counts = new Map();

  // Conta as tags da cópia local (tarefas/eventos + notas).
  function refresh() {
    const m = new Map();
    for (const r of [...store.rows('entries'), ...store.rows('notes')]) for (const t of r.tags || []) m.set(t, (m.get(t) || 0) + 1);
    counts = m;
  }

  // [[tag, quantidade], …] — mais usadas primeiro.
  const list = () => [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));

  // Liga sugestões a um <input>/<textarea>. Devolve a barra de sugestões para colocar logo abaixo.
  // extra: sugestões especiais, ex.: [{ tag: 'nota', label: '#nota → vai para Notas' }]
  function attach(field, { extra = [] } = {}) {
    const bar = h('div', { class: 'suggest', role: 'listbox' });
    bar.hidden = true;
    let current = [];
    let token = null;

    function hide() { bar.hidden = true; current = []; token = null; }

    function update() {
      const pos = field.selectionStart ?? field.value.length;
      const m = field.value.slice(0, pos).match(TOKEN_RE);
      if (!m) return hide();
      token = { start: pos - m[2].length, end: pos };
      const prefix = normalizeTag(m[2]);
      const seen = new Set();
      current = [
        ...extra.map((x) => ({ ...x, count: null })),
        ...list().map(([tag, count]) => ({ tag, count })),
      ].filter((x) => {
        if (seen.has(x.tag) || !x.tag.startsWith(prefix) || x.tag === prefix) return false;
        seen.add(x.tag);
        return true;
      }).slice(0, 8);
      if (!current.length) return hide();
      bar.replaceChildren(...current.map((x, i) => h('button', {
        type: 'button', class: 'tag-choice' + (i === 0 ? ' first' : ''),
        title: i === 0 ? 'Tab para escolher' : null,
        onmousedown: (ev) => ev.preventDefault(),   // mantém o foco no campo
        onclick: () => choose(x.tag),
      }, x.label || '#' + x.tag, x.count ? h('span', { class: 'count' }, x.count) : null)));
      bar.hidden = false;
    }

    function choose(tag) {
      if (!token) return;
      const v = field.value;
      const after = v.slice(token.end);
      const insert = tag + (after.startsWith(' ') ? '' : ' ');
      field.value = v.slice(0, token.start) + insert + after;
      const caret = token.start + insert.length;
      field.setSelectionRange(caret, caret);
      field.focus();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
    }

    field.addEventListener('input', update);
    field.addEventListener('click', update);
    field.addEventListener('keyup', (ev) => { if (ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') update(); });
    field.addEventListener('keydown', (ev) => {
      if (bar.hidden) return;
      if (ev.key === 'Tab') { ev.preventDefault(); choose(current[0].tag); }
      else if (ev.key === 'Escape') { ev.stopImmediatePropagation(); hide(); }
    }, true);
    field.addEventListener('blur', () => setTimeout(hide, 150));
    return bar;
  }

  return { refresh, list, attach };
}
