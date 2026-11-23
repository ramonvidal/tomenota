// Caderno de notas: textos livres, independentes do diário/tarefas.
// Salva sozinho enquanto você digita (sem botão "salvar").
import { extractTags, extractLinks } from './parse.js';

const SAVE_DELAY = 700;

export function createNotes({ sb, h, toast, check, state, render, openTag, openDay, tags: tagIndex }) {
  let draft = null;      // nota aberta no editor: { id|null, title, body, pinned, created_at, updated_at }
  let timer = null;
  let dirty = false;
  let chain = Promise.resolve();
  let ui = null;         // elementos do editor que atualizamos sem re-renderizar tudo
  let returnTo = null;   // para onde o "‹ voltar" leva (ex.: o Dia de onde a nota foi aberta)
  let linked = [];       // tarefas/eventos ligados a esta nota

  // ---------- Dados ----------
  async function loadList() {
    const res = await sb.from('notes').select('*')
      .order('pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(1000);
    check(res);
    state.notes = res.data;
  }

  async function search(term, tag) {
    const pattern = `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const base = () => {
      let q = sb.from('notes').select('*').order('updated_at', { ascending: false }).limit(100);
      if (tag) q = q.contains('tags', [tag]);
      return q;
    };
    const queries = term ? [base().ilike('title', pattern), base().ilike('body', pattern)] : [base()];
    const results = await Promise.all(queries);
    results.forEach(check);
    const byId = new Map();
    for (const r of results) for (const n of r.data) byId.set(n.id, n);
    return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  // Cria uma nota direto (usado pela entrada rápida do diário e pelo "mover para Notas").
  async function quickCreate({ title, body, day = null }) {
    const res = await sb.from('notes').insert({ title, body, day, tags: extractTags(title + '\n' + body) }).select().single();
    check(res);
    return res.data;
  }

  // opts.returnTo: função chamada pelo "‹ voltar" (sem ela, volta para a lista de Notas).
  async function open(id, opts = {}) {
    await flush();
    returnTo = opts.returnTo || null;
    linked = [];
    if (id) {
      const [res, ent] = await Promise.all([
        sb.from('notes').select('*').eq('id', id).single(),
        sb.from('entries').select('id, day, text, kind, status, month_only').eq('note_id', id).order('day'),
      ]);
      check(res);
      draft = res.data;
      // Antes do 006_task_notes.sql a coluna não existe: segue sem mostrar a tarefa.
      // Cópias migradas (> <) ficam de fora: mostra só a versão atual de cada tarefa.
      if (!ent.error) linked = ent.data.filter((e) => e.status !== 'migrated' && e.status !== 'scheduled');
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
      await sb.from('notes').delete().eq('id', draft.id);
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
    setStatus('salvando…');
    const res = target.id
      ? await sb.from('notes').update(row).eq('id', target.id).select().single()
      : await sb.from('notes').insert(row).select().single();
    if (res.error) {
      if (target === draft) dirty = true;
      setStatus('erro ao salvar — tentando de novo');
      toast('Erro ao salvar: ' + res.error.message);
      clearTimeout(timer);
      timer = setTimeout(flush, 3000);
      throw res.error;
    }
    target.id = res.data.id;
    target.created_at = res.data.created_at;
    target.updated_at = res.data.updated_at;
    if (target === draft) { setStatus(dirty ? 'editando…' : 'salvo'); if (ui) renderMeta(); }
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
        if (draft.id) check(await sb.from('notes').delete().eq('id', draft.id));
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
