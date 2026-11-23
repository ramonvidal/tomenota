// Caderno de notas: textos livres, independentes do diário/tarefas.
// Salva sozinho enquanto você digita (sem botão "salvar").
import { extractTags, extractLinks } from './parse.js';

const SAVE_DELAY = 700;

export function createNotes({ store, h, toast, state, render, openTag, openDay, tags: tagIndex }) {
  let draft = null;      // nota aberta no editor: { id|null, title, body, pinned, created_at, updated_at }
  let timer = null;
  let dirty = false;
  let chain = Promise.resolve();
  let ui = null;         // elementos do editor que atualizamos sem re-renderizar tudo
  let returnTo = null;   // para onde o "‹ voltar" leva (ex.: o Dia de onde a nota foi aberta)
  let linked = [];       // tarefas/eventos ligados a esta nota

  // ---------- Dados ----------
  // Tudo vem da cópia local (store.js): funciona offline e sincroniza depois.
  const byUpdatedDesc = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at));

  function loadList() {
    state.notes = store.rows('notes').sort((a, b) => (b.pinned - a.pinned) || byUpdatedDesc(a, b));
  }

  function search(term, tag) {
    const f = term.trim().toLowerCase();
    return store.rows('notes')
      .filter((n) => (!tag || n.tags.includes(tag)) && (!f || (n.title + '\n' + n.body).toLowerCase().includes(f)))
      .sort(byUpdatedDesc).slice(0, 100);
  }

  // Cria uma nota direto (entrada rápida do diário, nota de detalhes de uma tarefa).
  function quickCreate({ title, body, day = null }) {
    return store.insert('notes', { title, body, day, tags: extractTags(title + '\n' + body) });
  }

  // opts.returnTo: função chamada pelo "‹ voltar" (sem ela, volta para a lista de Notas).
  async function open(id, opts = {}) {
    await flush();
    returnTo = opts.returnTo || null;
    linked = [];
    if (id) {
      const row = store.get('notes', id);
      if (!row) { toast('Nota não encontrada (talvez apagada em outro aparelho).'); return; }
      draft = { ...row };   // cópia: o editor só grava na cópia local ao salvar
      // Cópias migradas (> <) ficam de fora: mostra só a versão atual de cada tarefa.
      linked = store.rows('entries').filter((e) => e.note_id === id && e.status !== 'migrated' && e.status !== 'scheduled')
        .sort((a, b) => a.day.localeCompare(b.day));
    } else {
      draft = { id: null, title: '', body: '', pinned: false, created_at: null, updated_at: null };
    }
    state.view = 'notes';
    state.noteOpen = true;
    render();
    queueMicrotask(() => {
      const el = draft.id ? ui?.body : ui?.title;
      el?.focus();
      if (opts.caretStart && el?.setSelectionRange) el.setSelectionRange(0, 0);
    });
  }

  async function close() {
    await flush();
    // Nota que ficou vazia não vale a pena guardar.
    if (draft?.id && !draft.title.trim() && !draft.body.trim()) {
      await store.remove('notes', draft.id);
    }
    draft = null; ui = null; linked = [];
    state.noteOpen = false;
  }

  function setStatus(text) { if (ui) ui.status.textContent = text; }

  function schedule() {
    dirty = true;
    setStatus('editando…');
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY);
  }

  // Grava as mudanças pendentes. As gravações ficam em fila para nunca se atropelarem.
  function flush() {
    clearTimeout(timer);
    if (!dirty || !draft) return chain;
    dirty = false;
    const target = draft;
    const snap = { title: target.title, body: target.body, pinned: target.pinned };
    chain = chain.then(() => persist(target, snap)).catch(() => {});
    return chain;
  }

  async function persist(target, snap) {
    const row = { ...snap, tags: extractTags(snap.title + '\n' + snap.body) };
    if (!target.id && !snap.title.trim() && !snap.body.trim()) { setStatus(''); return; }
    if (target.id && store.get('notes', target.id)) {
      await store.update('notes', target.id, row);
    } else {
      const saved = await store.insert('notes', row);
      target.id = saved.id;
      target.created_at = saved.created_at;
    }
    // Sem conexão: fica salvo neste aparelho e vai para o servidor quando a internet voltar.
    if (target === draft) { setStatus(dirty ? 'editando…' : store.online ? 'salvo' : 'salvo neste aparelho'); if (ui) renderMeta(); }
  }

  const hasPending = () => dirty;

  // ---------- Render ----------
  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  };

  function titleOf(n) {
    return n.title.trim() || n.body.trim().split('\n')[0].slice(0, 80) || 'Sem título';
  }

  function snippetOf(n) {
    const body = n.title.trim() ? n.body : n.body.trim().split('\n').slice(1).join(' ');
    return body.replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  function noteRow(n) {
    return h('li', { class: 'note-row' },
      h('button', { class: 'note-link', onclick: () => open(n.id) },
        h('span', { class: 'note-row-title' }, n.pinned ? h('span', { class: 'pin', title: 'Fixada' }, '📌 ') : null, titleOf(n)),
        h('span', { class: 'note-row-meta' }, fmtWhen(n.updated_at)),
        snippetOf(n) ? h('span', { class: 'note-row-snippet' }, snippetOf(n)) : null,
      ),
    );
  }

  // Filtro por tag na aba Notas: '' = todas, '__none__' = sem tag, ou o nome da tag.
  const NO_TAG = '__none__';
  const byText = (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base', numeric: true });

  function renderList(main) {
    const listEl = h('ul', { class: 'notes' });
    const empty = h('p', { class: 'empty' });
    const tagBar = h('div', { class: 'note-tags', role: 'toolbar', 'aria-label': 'Filtrar por tag' });

    // Lista automática de tags, montada a partir das notas (mais usadas primeiro).
    const counts = new Map();
    let untagged = 0;
    for (const n of state.notes || []) {
      if (!n.tags.length) untagged++;
      for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const allTags = [...counts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
    if (state.noteTag && state.noteTag !== NO_TAG && !counts.has(state.noteTag)) state.noteTag = '';  // tag sumiu

    const matches = (n) => {
      const f = (state.noteFilter || '').trim().toLowerCase();
      const t = state.noteTag || '';
      if (t === NO_TAG ? n.tags.length : t && !n.tags.includes(t)) return false;
      return !f || (n.title + '\n' + n.body).toLowerCase().includes(f);
    };

    const chip = (value, label, count, plain = false) => h('button', {
      type: 'button', class: 'kind' + (plain ? ' plain' : '') + ((state.noteTag || '') === value ? ' on' : ''),
      'aria-pressed': String((state.noteTag || '') === value),
      onclick: () => { state.noteTag = (state.noteTag || '') === value ? '' : value; fill(); },
    }, label, count != null ? h('span', { class: 'count' }, count) : null);

    const fill = () => {
      tagBar.replaceChildren(
        chip('', 'todas', (state.notes || []).length, true),
        ...allTags.map(([t, n]) => chip(t, '#' + t, n)),
        untagged && allTags.length ? chip(NO_TAG, 'sem tag', untagged, true) : null,
      );
      tagBar.hidden = !allTags.length;
      const shown = (state.notes || []).filter(matches);
      listEl.replaceChildren(...shown.map(noteRow));
      empty.hidden = shown.length > 0 || !state.notes;
      empty.textContent = state.noteFilter?.trim() || state.noteTag ? 'Nenhuma nota encontrada.' : 'Nenhuma nota ainda. Crie a primeira.';
    };

    main.append(
      h('div', { class: 'notes-head' },
        h('h2', {}, 'notas'),
        h('button', { class: 'primary', onclick: () => open(null) }, '+ Nova nota'),
      ),
      h('input', {
        id: 'quick', class: 'quick', type: 'search', placeholder: 'Filtrar notas…', value: state.noteFilter || '',
        oninput: (ev) => { state.noteFilter = ev.target.value; fill(); },
      }),
      tagBar,
    );
    main.append(listEl, empty);
    fill();
  }

  function renderMeta() {
    const text = draft.title + '\n' + draft.body;
    const tags = extractTags(text);
    const links = extractLinks(draft.body);
    ui.meta.replaceChildren(...[
      tags.length ? h('div', { class: 'tags' }, tags.map((t) => h('button', { class: 'tag', onclick: () => openTag(t) }, '#' + t))) : null,
      links.length ? h('div', { class: 'links' }, links.map((u) => {
        let label = u;
        try { const x = new URL(u); label = x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname : ''); } catch {}
        return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, '↗ ' + (label.length > 60 ? label.slice(0, 59) + '…' : label));
      })) : null,
      linked.length ? h('div', { class: 'linked-tasks' }, linked.map((e) => h('button', {
        class: 'linked-task', title: 'Abrir o dia desta tarefa',
        onclick: () => !e.month_only && openDay(e.day),
      },
      h('span', { class: 'muted' }, e.kind === 'event' ? 'Evento: ' : 'Tarefa: '),
      `${e.kind === 'event' ? '○' : e.status === 'done' ? '×' : '•'} ${e.text}`,
      h('span', { class: 'muted' }, ' · ' + new Date(e.day + 'T12:00').toLocaleDateString('pt-BR', e.month_only ? { month: 'short', year: 'numeric' } : { weekday: 'short', day: '2-digit', month: '2-digit' }))))) : null,
      draft.created_at ? h('div', { class: 'muted small' }, `criada ${fmtWhen(draft.created_at)}`,
        draft.day ? [' · no diário de ', h('button', { class: 'link-inline', onclick: () => openDay(draft.day) },
          new Date(draft.day + 'T12:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }))] : null) : null,
    ].filter(Boolean));
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function renderEditor(main) {
    const goBack = returnTo;
    const back = h('button', {
      class: 'back',
      onclick: async () => { await close(); if (goBack) goBack(); else { await loadList(); render(); } },
    }, goBack ? '‹ voltar' : '‹ notas');
    const status = h('span', { class: 'status muted small' }, draft.id ? 'salvo' : '');
    const pin = h('button', {
      class: 'chip' + (draft.pinned ? ' on' : ''),
      title: 'Fixar no topo da lista',
      onclick: () => { draft.pinned = !draft.pinned; pin.classList.toggle('on', draft.pinned); pin.textContent = draft.pinned ? '📌 fixada' : 'fixar'; schedule(); flush(); },
    }, draft.pinned ? '📌 fixada' : 'fixar');
    const del = h('button', {
      class: 'chip danger',
      onclick: async () => {
        if (!confirm('Apagar esta nota?')) return;
        clearTimeout(timer); dirty = false;
        await chain;
        if (draft.id) await store.remove('notes', draft.id);
        draft = null; ui = null; linked = []; state.noteOpen = false;
        if (goBack) goBack(); else { await loadList(); render(); }
        toast('Nota apagada.');
      },
    }, 'apagar');

    const title = h('input', {
      class: 'note-title', placeholder: 'Título', value: draft.title, maxlength: 300,
      oninput: (ev) => { draft.title = ev.target.value; schedule(); renderMeta(); },
      onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); body.focus(); } },
    });
    const body = h('textarea', {
      class: 'note-body', rows: 12, maxlength: 100000,
      placeholder: 'Escreva à vontade…\n\nUse #tags para organizar. Links (https://…) ficam clicáveis abaixo.',
      oninput: (ev) => { draft.body = ev.target.value; autosize(ev.target); schedule(); renderMeta(); },
    });
    body.value = draft.body;
    const meta = h('div', { class: 'note-meta' });
    ui = { title, body, status, meta };

    main.append(
      h('div', { class: 'note-bar' }, back, h('span', { class: 'spacer' }), status, pin, del),
      title, tagIndex.attach(title),
      body, tagIndex.attach(body),
      meta,
    );
    renderMeta();
    queueMicrotask(() => autosize(body));
  }

  function renderView(main) {
    if (state.noteOpen && draft) renderEditor(main);
    else renderList(main);
  }

  return { loadList, search, open, close, flush, hasPending, renderView, noteRow, quickCreate };
}
