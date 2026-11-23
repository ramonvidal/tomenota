import './style.css';
import { createClient } from '@supabase/supabase-js';
import { parseEntry, splitTitle, isoDay, addDays, fromIso, firstOfMonth, nextWorkday, NOTE_TAG } from './parse.js';
import { createCalendar, lowerSaxonyHolidays, WEEKDAY_NAMES } from './calendar.js';
import { createTags } from './tags.js';
import { createMenu } from './menu.js';
import { createExport } from './export.js';
import { createNotes } from './notes.js';

// Aceita também a URL copiada com /rest/v1/ ou / no final: usa só https://xxxx.supabase.co
const SB_URL = (() => {
  const raw = (import.meta.env.VITE_SUPABASE_URL || '').trim();
  try { return new URL(raw).origin; } catch { return raw; }
})();
const SB_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

// Se algo der errado, mostra o erro na tela em vez de uma página em branco.
function fatal(title, detail) {
  const box = document.createElement('div');
  box.className = 'fatal';
  const h = document.createElement('h1'); h.textContent = title;
  const p = document.createElement('pre'); p.textContent = detail;
  box.append(h, p);
  document.getElementById('app').replaceChildren(box);
}
window.addEventListener('error', (e) => !['missing config', 'framed'].includes(e.error?.message) && fatal('Erro', String(e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => fatal('Erro', String(e.reason?.stack || e.reason?.message || e.reason)));

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SB_URL) || !SB_KEY) {
  fatal('Configuração faltando',
    'As variáveis de build não chegaram ao site.\n\n' +
    `VITE_SUPABASE_URL: ${SB_URL ? `"${SB_URL}" (formato esperado: https://xxxx.supabase.co, sem / no final)` : 'VAZIA'}\n` +
    `VITE_SUPABASE_ANON_KEY: ${SB_KEY ? 'ok (' + SB_KEY.length + ' caracteres)' : 'VAZIA'}\n\n` +
    'Cloudflare → tomenota → Settings → Build → Variables and secrets, depois faça um novo deploy.');
  throw new Error('missing config');
}

const sb = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});

// ---------- Tema: automático (segue o sistema) | claro | escuro (preto) ----------
const THEME_KEY = 'tomenota-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme = localStorage.getItem(THEME_KEY) || 'auto') {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  // Cor da barra do navegador/celular acompanha o fundo.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
function setTheme(theme) {
  if (theme === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}
applyTheme();
darkQuery.addEventListener('change', () => applyTheme());

const app = document.getElementById('app');

// Não rodar dentro de iframe de outro site (proteção contra clickjacking; o GitHub Pages não deixa mandar header para isso).
if (window.top !== window.self) {
  app.textContent = 'Abra o Tome Nota! diretamente: ' + location.href;
  throw new Error('framed');
}
const state = {
  session: null,
  stage: 'loading',     // loading | login | mfa | recovery | app
  recovery: false,
  view: 'day',          // day | future | open | notes | search (Índice) | export | account
  dayNotes: [],
  pinnedNotes: [],
  futureSummary: [],
  kind: 'task',         // tipo escolhido nos botões: task | event | note
  notes: null,
  noteOpen: false,
  noteFilter: '',
  searchNotes: [],
  factors: null,
  enroll: null,
  day: isoDay(),
  entries: [],
  overdue: 0,
  query: '',
  tag: null,
  busy: false,
  editing: null,
};

// ---------- DOM helper (sempre textContent → sem XSS) ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const fmtLong = (iso) =>
  fromIso(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = (iso) =>
  fromIso(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

function toast(msg, action) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());   // um aviso por vez
  const t = h('div', { class: 'toast' }, msg,
    action ? h('button', { class: 'toast-action', onclick: () => { t.remove(); action.fn(); } }, action.label) : null);
  document.body.append(t);
  setTimeout(() => t.remove(), action ? 6000 : 3500);
}

function check({ error }) {
  if (error) { toast(error.message); throw error; }
}

const tags = createTags({ sb, h });
const menu = createMenu(h);
const exporter = createExport({ sb, h, check, toast, tags });
const cal = createCalendar({ sb, check, state });

const notes = createNotes({
  sb, h, toast, check, state, tags,
  render: () => render(),
  openTag: (t) => { state.tag = t; state.query = ''; go('search'); },
  openDay: (day) => go('day', day),
});

// ---------- Dados ----------
const monthLabel = (iso) => fromIso(iso).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const monthShort = (iso) => fromIso(iso).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
const isFutureMonth = (iso) => firstOfMonth(iso) > firstOfMonth(isoDay());

// Tudo que está à frente: dias depois de hoje + itens "só do mês" do mês atual em diante.
async function fetchFuture() {
  const t = isoDay();
  const [a, b] = await Promise.all([
    sb.from('entries').select('*').gt('day', t).order('day').order('created_at').limit(1000),
    sb.from('entries').select('*').eq('month_only', true).gte('day', firstOfMonth(t)).lte('day', t).order('created_at'),
  ]);
  check(a); check(b);
  const byId = new Map([...b.data, ...a.data].map((e) => [e.id, e]));
  return [...byId.values()].filter((e) => e.status !== 'migrated' && e.status !== 'scheduled')
    .sort((x, y) => x.day.localeCompare(y.day) || (y.month_only - x.month_only) || x.created_at.localeCompare(y.created_at));
}

// Cada carga tem um número; se outra começou depois, a resposta antiga é descartada
// (evita que uma resposta lenta apague o resultado mais novo, ex.: digitar logo ao abrir o Índice).
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  const stale = () => seq !== loadSeq;
  if (state.view === 'account') {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (stale()) return;
    if (error) toast(error.message);
    state.factors = data || { all: [], totp: [] };
    return render();
  }
  if (state.view === 'export') return render();   // a tela de exportar busca os próprios dados
  if (state.view === 'notes') {
    if (!state.noteOpen) await notes.loadList();
    if (stale()) return;
    return render();
  }
  state.busy = true;
  state.dayNotes = [];
  state.overdue = 0;

  if (state.view === 'day') {
    const [res, nres] = await Promise.all([
      sb.from('entries').select('*').eq('day', state.day).eq('month_only', false).order('created_at'),
      sb.from('notes').select('*').eq('day', state.day).order('created_at'),
    ]);
    check(res); check(nres);
    if (stale()) return;
    state.entries = res.data;
    const linkedIds = new Set(res.data.map((e) => e.note_id).filter(Boolean));
    state.dayNotes = nres.data.filter((n) => !linkedIds.has(n.id));
    if (state.day === isoDay()) {
      const [o1, o2] = await Promise.all([
        sb.from('entries').select('id', { count: 'exact', head: true })
          .eq('kind', 'task').eq('status', 'open').eq('month_only', false).lt('day', state.day),
        sb.from('entries').select('id', { count: 'exact', head: true })
          .eq('kind', 'task').eq('status', 'open').eq('month_only', true).lt('day', firstOfMonth(state.day)),
      ]);
      if (stale()) return;
      state.overdue = (o1.count || 0) + (o2.count || 0);
    }
  } else if (state.view === 'future') {
    const future = await fetchFuture();
    if (stale()) return;
    state.entries = future;
  } else if (state.view === 'open') {
    let q = sb.from('entries').select('*').eq('kind', 'task').eq('status', 'open')
      .order('day').order('month_only', { ascending: false }).order('priority', { ascending: false }).order('created_at');
    if (state.tag) q = q.contains('tags', [state.tag]);
    const res = await q; check(res);
    if (stale()) return;
    state.entries = res.data;
  } else {
    // Índice: busca + coleções (tags) + notas fixadas + resumo do futuro.
    const term = state.query.trim();
    if (!term && !state.tag) {
      const [pinned, future] = await Promise.all([
        sb.from('notes').select('*').eq('pinned', true).order('updated_at', { ascending: false }).limit(50),
        fetchFuture(),
      ]);
      check(pinned);
      if (stale()) return;
      state.pinnedNotes = pinned.data;
      const months = new Map();
      for (const e of future) { const m = firstOfMonth(e.day); months.set(m, (months.get(m) || 0) + 1); }
      state.futureSummary = [...months];
      state.entries = []; state.searchNotes = [];
    } else {
      let q = sb.from('entries').select('*');
      if (term) q = q.ilike('text', `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
      if (state.tag) q = q.contains('tags', [state.tag]);
      const [res, found] = await Promise.all([q.order('day', { ascending: false }).limit(200), notes.search(term, state.tag)]);
      check(res);
      if (stale()) return;
      state.entries = res.data;
      state.searchNotes = found;
    }
  }
  state.busy = false;
  render();
}

// Uma "Nota" vai sempre para o caderno de Notas (e aparece no dia em que foi anotada).
// "Título: corpo" → título + corpo; as #tags vão no fim do corpo.
async function createNote(text, entryTags, day) {
  const { title, body } = splitTitle(text);
  const tagLine = entryTags.map((t) => '#' + t).join(' ');
  const note = await notes.quickCreate({ title, body: [body, tagLine].filter(Boolean).join('\n\n'), day });
  toast(`Nota salva em Notas: ${title}`, { label: 'abrir', fn: () => notes.open(note.id) });
  tags.refresh();
  return note;
}

async function add(raw) {
  const base = state.view === 'day' ? state.day : isoDay();
  const e = parseEntry(raw, base, state.kind);
  if (!e.text) return;
  // No Futuro, sem @data → vai para o próximo mês (sem dia), como no Future Log de papel.
  if (state.view === 'future' && !/(^|\s)@\S/.test(raw)) {
    const d = fromIso(isoDay());
    e.day = isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    e.month_only = true;
  }
  if (e.kind === 'note') {
    await createNote(e.text, e.tags, e.month_only ? null : e.day);
    return load();
  }
  check(await sb.from('entries').insert(e));
  if (e.month_only) toast(`Agendado para ${monthLabel(e.day)} (Futuro)`);
  else if (state.view === 'day' && e.day !== state.day) toast(`Anotado para ${fmtShort(e.day)}`);
  if (e.tags.length) tags.refresh();
  await load();
}

// Trocar o tipo de uma entrada. Virar "nota" leva o texto para o caderno de Notas.
async function changeKind(e, kind) {
  if (kind === e.kind) return;
  if (kind === 'note') {
    await createNote(e.text, e.tags, e.month_only ? null : e.day);
    check(await sb.from('entries').delete().eq('id', e.id));
    return load();
  }
  await update(e.id, { kind });
}

async function update(id, patch) {
  check(await sb.from('entries').update(patch).eq('id', id));
  await load();
}

async function remove(id) {
  check(await sb.from('entries').delete().eq('id', id));
  await load();
}

// Migração estilo bullet journal: uma cópia vai para o destino e o original fica marcado:
//   ">" migrado (outro dia, mesmo mês ou passado)   "<" agendado (mês futuro = Future Log)
async function migrate(entries, target, monthOnly = false) {
  if (!entries.length) return;
  check(await sb.from('entries').insert(entries.map((e) => ({
    kind: e.kind, text: e.text, tags: e.tags, priority: e.priority, day: target, month_only: monthOnly,
    ...(e.note_id ? { note_id: e.note_id } : {}),   // a nota de detalhes acompanha a tarefa
  }))));
  const status = isFutureMonth(target) ? 'scheduled' : 'migrated';
  check(await sb.from('entries').update({ status }).in('id', entries.map((e) => e.id)));
  if (status === 'scheduled') toast(`Agendado para ${monthOnly ? monthLabel(target) : fmtShort(target)} (Futuro)`);
  await load();
}

async function migrateOverdue() {
  const t = isoDay();
  const [a, b] = await Promise.all([
    sb.from('entries').select('*').eq('kind', 'task').eq('status', 'open').eq('month_only', false).lt('day', t),
    sb.from('entries').select('*').eq('kind', 'task').eq('status', 'open').eq('month_only', true).lt('day', firstOfMonth(t)),
  ]);
  check(a); check(b);
  const all = [...a.data, ...b.data];
  await migrate(all, t);
  toast(`${all.length} tarefa(s) migrada(s) para hoje`);
}

// ---------- Render ----------
const KINDS = [
  { kind: 'task', icon: '•', label: 'Tarefa', placeholder: 'Nova tarefa…   * importante · #tag · @amanhã · @dez' },
  { kind: 'event', icon: '○', label: 'Evento', placeholder: 'Novo evento…   @sex · @25/12 · #tag' },
  { kind: 'note', icon: '–', label: 'Nota', placeholder: 'Nota (vai para Notas)…   Título: texto · #tag' },
];

// ---------- Nota de detalhes ligada a uma tarefa ----------
// Abre a nota e faz o "‹ voltar" do editor retornar para a tela atual (ex.: o Dia).
function openLinkedNote(noteId, extra = {}) {
  const back = { view: state.view, day: state.day };
  return notes.open(noteId, { returnTo: () => go(back.view, back.day), ...extra });
}

async function linkNote(e, noteId) {
  const res = await sb.from('entries').update({ note_id: noteId }).eq('id', e.id);
  if (res.error) {
    // Coluna ainda não existe: falta rodar o 006_task_notes.sql.
    toast(/note_id/.test(res.error.message) ? 'Rode o supabase/006_task_notes.sql no Supabase para ligar notas a tarefas.' : res.error.message);
    throw res.error;
  }
  e.note_id = noteId;
}

async function createDetailNote(e) {
  // Primeira linha vazia (o cursor fica nela); as tags da tarefa vão no fim.
  const tagLine = e.tags.map((t) => '#' + t).join(' ');
  const note = await notes.quickCreate({ title: e.text, body: tagLine ? '\n\n' + tagLine : '' });
  try { await linkNote(e, note.id); } catch { await sb.from('notes').delete().eq('id', note.id); return; }
  tags.refresh();
  openLinkedNote(note.id, { caretStart: true });
}

// Submenu: escolher uma nota existente (com busca).
function pickNote(api, e, back) {
  const results = h('div', { class: 'menu-notes' });
  let all = [];
  const show = (q) => {
    const f = q.trim().toLowerCase();
    const list = all.filter((n) => !f || (n.title + ' ' + n.body).toLowerCase().includes(f)).slice(0, 30);
    results.replaceChildren(...(list.length ? list.map((n) => menu.item(n.title || 'Sem título', async () => { await linkNote(e, n.id); load(); toast('Nota ligada à tarefa.'); }, {
      hint: new Date(n.updated_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    })) : [h('div', { class: 'menu-title' }, all.length ? 'Nenhuma nota encontrada' : 'Carregando…')]));
  };
  const search = h('input', { type: 'search', class: 'date-pick', placeholder: 'Buscar nota…', oninput: (ev) => show(ev.target.value) });
  api.set(menu.item('‹ voltar', () => api.set(back(api)), { keepOpen: true }), h('div', { class: 'menu-date' }, search), results);
  show('');
  sb.from('notes').select('id, title, body, updated_at').order('updated_at', { ascending: false }).limit(500).then((res) => {
    if (res.error) return toast(res.error.message);
    all = res.data; show(search.value);
  });
}

// Menu "⋯" de uma tarefa/evento.
function entryMenu(e, anchor) {
  const open = e.status === 'open';
  const today = isoDay();
  const tomorrow = nextWorkday();   // "amanhã" = próximo dia útil
  const literalTomorrow = tomorrow === addDays(today, 1);
  const kindRow = () => h('div', { class: 'menu-kinds' }, KINDS.map((k) => h('button', {
    type: 'button', class: 'kind' + (k.kind === e.kind ? ' on' : ''),
    onclick: () => { menu.close(); changeKind(e, k.kind); },
  }, h('span', { class: 'kind-icon' }, k.icon), k.label)));

  const schedule = (api) => {
    const d = fromIso(today);
    const months = Array.from({ length: 12 }, (_, i) => isoDay(new Date(d.getFullYear(), d.getMonth() + 1 + i, 1)));
    const picker = h('input', { type: 'date', class: 'date-pick', min: addDays(today, 1), value: tomorrow });
    api.set(
      menu.item('‹ voltar', () => api.set(main(api)), { keepOpen: true }),
      menu.title('Para um dia'),
      h('form', {
        class: 'menu-date',
        onsubmit: (ev) => { ev.preventDefault(); if (picker.value) { menu.close(); migrate([e], picker.value); } },
      }, picker, h('button', { type: 'submit', class: 'primary' }, 'Agendar')),
      menu.title('Para um mês (Future Log, sem dia)'),
      h('div', { class: 'menu-months' }, months.map((m) => h('button', {
        type: 'button', class: 'kind', onclick: () => { menu.close(); migrate([e], m, true); },
      }, capitalize(fromIso(m).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', ''))))),
    );
  };

  const main = (api) => [
    e.kind === 'task' && open && (e.month_only || e.day !== today)
      ? menu.item('→ Hoje', () => migrate([e], today)) : null,
    e.kind === 'task' && open && (e.month_only || e.day !== tomorrow)
      ? menu.item(literalTomorrow ? '→ Amanhã' : '→ Próximo dia útil', () => migrate([e], tomorrow), { hint: fmtShort(tomorrow) }) : null,
    open ? menu.item('Agendar…', () => schedule(api), { keepOpen: true, hint: 'dia ou mês' }) : null,
    menu.item(e.priority ? 'Tirar importante' : 'Marcar importante', () => update(e.id, { priority: e.priority ? 0 : 1 }), { hint: '*' }),
    menu.sep(),
    ...(e.note_id ? [
      menu.item('Abrir nota de detalhes', () => openLinkedNote(e.note_id), { hint: '📄' }),
      menu.item('Desligar nota', async () => { await linkNote(e, null); load(); toast('Nota desligada (ela continua em Notas).'); }),
    ] : [
      menu.item('Criar nota de detalhes', () => createDetailNote(e), { hint: '📄' }),
      menu.item('Ligar a uma nota existente…', () => pickNote(api, e, main), { keepOpen: true }),
    ]),
    menu.sep(),
    menu.title('Tipo'),
    kindRow(),
    menu.sep(),
    menu.item('Editar', () => { state.editing = e.id; render(); }, { hint: '2 cliques' }),
    menu.item('Apagar', () => confirm('Apagar?') && remove(e.id), { danger: true }),
  ];
  menu.open(anchor, main);
}

const moreButton = (onclick) => h('button', { class: 'more', title: 'Ações', 'aria-label': 'Ações', 'aria-haspopup': 'menu', onclick: (ev) => onclick(ev.currentTarget) }, '⋯');

const BULLET = {
  task: { open: '•', done: '×', migrated: '>', scheduled: '<', cancelled: '•' },
  event: { open: '○', done: '◉', migrated: '>', scheduled: '<', cancelled: '○' },
  // Notas antigas do diário (antes do 004_bujo.sql) ainda podem existir: mostra sem quebrar a tela.
  note: { open: '–', done: '–', migrated: '>', scheduled: '<', cancelled: '–' },
};
const bulletFor = (e) => (BULLET[e.kind] || BULLET.task)[e.status] || '•';
const STATUS_TITLE = { migrated: 'Migrada para outro dia (>)', scheduled: 'Agendada para o futuro (<)' };

function dayLabel(e, mode) {
  if (!mode) return null;
  const label = e.month_only ? (mode === 'inMonth' ? 'sem dia' : monthShort(e.day))
    : mode === 'inMonth' ? fromIso(e.day).toLocaleDateString('pt-BR', { day: '2-digit', weekday: 'short' }).replace('.', '')
      : fmtShort(e.day);
  return h('button', { class: 'day-link', title: 'Abrir o dia', onclick: () => !e.month_only && go('day', e.day) }, label);
}

function entryRow(e, mode) {
  const toggle = () => {
    if (e.kind !== 'task' || e.status === 'migrated' || e.status === 'scheduled') return;
    update(e.id, { status: e.status === 'done' ? 'open' : 'done' });
  };

  let body;
  if (state.editing === e.id) {
    const input = h('input', {
      class: 'edit', value: e.text, maxlength: 2000, title: 'Enter salva · comece com "* " para marcar como importante',
      onkeydown: (ev) => {
        if (ev.key === 'Enter') {
          state.editing = null;
          let t = ev.target.value.trim();
          const star = /^\*\s+/.test(t);            // "* texto" ao editar = marcar como importante
          if (star) t = t.replace(/^\*\s+/, '');
          const patch = {};
          if (t && t !== e.text) patch.text = t;
          if (star && !e.priority) patch.priority = 1;
          Object.keys(patch).length ? update(e.id, patch) : render();
        }
        if (ev.key === 'Escape') { state.editing = null; render(); }
      },
      onblur: () => { if (state.editing === e.id) { state.editing = null; render(); } },
    });
    queueMicrotask(() => { input.focus(); input.select(); });
    body = input;
  } else {
    body = h('span', { class: 'text', ondblclick: () => { state.editing = e.id; render(); } }, e.text);
  }

  // tabindex -1: tocar na linha (celular) a "seleciona".
  return h('li', { class: `entry ${e.kind} ${e.status}${e.priority ? ' important' : ''}`, tabindex: '-1' },
    h('button', {
      class: 'sig', title: e.priority ? 'Importante (clique para tirar)' : 'Marcar como importante',
      onclick: () => update(e.id, { priority: e.priority ? 0 : 1 }),
    }, e.priority ? '*' : ''),
    h('button', { class: 'bullet', title: STATUS_TITLE[e.status] || (e.kind === 'task' ? 'Concluir / reabrir' : 'Evento'), onclick: toggle }, bulletFor(e)),
    h('div', { class: 'body' },
      body,
      e.note_id ? h('button', { class: 'note-chip', title: 'Abrir a nota de detalhes', onclick: () => openLinkedNote(e.note_id) }, svgIcon('notes'), 'nota') : null,
      e.tags.length ? h('span', { class: 'tags' }, e.tags.map((t) =>
        h('button', { class: 'tag', onclick: () => { state.tag = t; state.view = 'search'; state.query = ''; load(); } }, '#' + t))) : null,
      dayLabel(e, mode),
    ),
    moreButton((anchor) => entryMenu(e, anchor)),
  );
}

// Nota do caderno mostrada no dia em que foi anotada.
function noteDayRow(n) {
  const snippet = n.body.replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return h('li', { class: 'entry note open', tabindex: '-1' },
    h('span', { class: 'sig' }),
    h('button', { class: 'bullet', title: 'Abrir nota', onclick: () => notes.open(n.id) }, '–'),
    h('div', { class: 'body' },
      h('button', { class: 'text note-open', onclick: () => notes.open(n.id) }, n.title || 'Sem título'),
      snippet ? h('span', { class: 'note-snippet' }, snippet.length > 90 ? snippet.slice(0, 89) + '…' : snippet) : null,
      n.tags.length ? h('span', { class: 'tags' }, n.tags.map((t) =>
        h('button', { class: 'tag', onclick: () => { state.tag = t; state.view = 'search'; state.query = ''; load(); } }, '#' + t))) : null,
    ),
    moreButton((anchor) => menu.open(anchor, () => [
      menu.item('Abrir nota', () => notes.open(n.id)),
      menu.item('Apagar', async () => { if (!confirm('Apagar esta nota?')) return; check(await sb.from('notes').delete().eq('id', n.id)); load(); }, { danger: true }),
    ])),
  );
}

async function go(view, day) {
  if (state.noteOpen) { await notes.close(); tags.refresh(); }
  const changed = view !== state.view || (day && day !== state.day);
  state.view = view;
  if (day) state.day = day;
  if (view !== 'search') state.tag = view === 'open' ? state.tag : null;
  state.editing = null;
  menu.close();
  // Troca de tela na hora (sem esperar a rede); os dados chegam logo depois.
  if (changed) {
    state.entries = []; state.dayNotes = []; state.searchNotes = []; state.overdue = 0; state.busy = true;
    if (view !== 'account' || state.factors) render();
  }
  load();
}

function setKind(kind, input) {
  state.kind = kind;
  const k = KINDS.find((x) => x.kind === kind);
  document.querySelectorAll('.kinds .kind').forEach((b, i) => {
    const on = KINDS[i].kind === kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  input.placeholder = k.placeholder;
  input.focus();
}

// ---------- Autenticação ----------
function authCard(title, msg, ...fields) {
  return h('div', { class: 'login' }, h('h1', {}, 'Tome Nota!'), title ? h('h2', {}, title) : null, msg, ...fields);
}

async function busyBtn(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

function renderLogin() {
  const msg = h('p', { class: 'muted' }, 'Entre com seu e-mail e senha.');
  const email = h('input', { type: 'email', required: true, placeholder: 'e-mail', autocomplete: 'username', name: 'email' });
  const pass = h('input', { type: 'password', required: true, placeholder: 'senha', autocomplete: 'current-password', name: 'password' });
  const btn = h('button', { type: 'submit' }, 'Entrar');
  const forgot = h('button', {
    type: 'button', class: 'link',
    onclick: () => busyBtn(forgot, async () => {
      if (!email.value.trim()) { msg.textContent = 'Digite seu e-mail acima e clique de novo em "Esqueci a senha".'; email.focus(); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + location.pathname });
      msg.textContent = error ? 'Erro: ' + error.message : 'Se o e-mail existir, enviamos um link para criar uma nova senha.';
    }),
  }, 'Esqueci a senha');
  const form = h('form', {
    onsubmit: (ev) => {
      ev.preventDefault();
      busyBtn(btn, async () => {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if (error) { msg.textContent = error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : 'Erro: ' + error.message; pass.select(); }
      });
    },
  }, email, pass, btn);
  app.replaceChildren(authCard(null, msg, form, forgot));
  email.focus();
}

function codeInput() {
  return h('input', {
    inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6,
    required: true, placeholder: '123456', class: 'code',
  });
}

function renderMfa() {
  const msg = h('p', { class: 'muted' }, 'Digite o código de 6 dígitos do seu app autenticador.');
  const code = codeInput();
  const btn = h('button', { type: 'submit' }, 'Verificar');
  const form = h('form', {
    onsubmit: (ev) => {
      ev.preventDefault();
      busyBtn(btn, async () => {
        const { data } = await sb.auth.mfa.listFactors();
        const factor = data?.totp?.[0];
        if (!factor) { msg.textContent = 'Nenhum autenticador encontrado.'; return; }
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.value.trim() });
        if (error) { msg.textContent = 'Código inválido. Tente de novo.'; code.select(); return; }
        refreshAuth();
      });
    },
  }, code, btn);
  app.replaceChildren(authCard('Verificação em 2 etapas', msg, form,
    h('button', { class: 'link', onclick: () => sb.auth.signOut({ scope: 'local' }) }, 'Cancelar e sair')));
  code.focus();
}

function passwordForm(onDone) {
  const p1 = h('input', { type: 'password', required: true, minlength: 10, placeholder: 'nova senha (mín. 10 caracteres)', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', required: true, minlength: 10, placeholder: 'repita a nova senha', autocomplete: 'new-password' });
  const btn = h('button', { type: 'submit' }, 'Salvar senha');
  return h('form', {
    class: 'stack',
    onsubmit: (ev) => {
      ev.preventDefault();
      if (p1.value !== p2.value) { toast('As senhas não são iguais.'); p2.select(); return; }
      busyBtn(btn, async () => {
        const { error } = await sb.auth.updateUser({ password: p1.value });
        if (error) { toast('Erro: ' + error.message); return; }
        p1.value = p2.value = '';
        toast('Senha salva.');
        onDone?.();
      });
    },
  }, p1, p2, btn);
}

function renderRecovery() {
  app.replaceChildren(authCard('Criar nova senha', h('p', { class: 'muted' }, 'Escolha uma senha nova para sua conta.'),
    passwordForm(() => { state.recovery = false; refreshAuth(); })));
}

async function refreshAuth() {
  let stage;
  if (!state.session) stage = 'login';
  else {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') stage = 'mfa';
    else if (state.recovery) stage = 'recovery';
    else stage = 'app';
  }
  if (stage === state.stage) return;
  state.stage = stage;
  if (stage === 'app') {
    await cal.load();
    load();
    tags.refresh().then(() => { if (state.view === 'search' && !state.query.trim() && !state.tag) render(); });
  } else render();
}

// ---------- Conta ----------
// "sex., 20/11" no ano atual; "sex., 01/01/27" nos outros.
const fmtHoliday = (iso) => fromIso(iso).toLocaleDateString('pt-BR', {
  weekday: 'short', day: '2-digit', month: '2-digit',
  year: fromIso(iso).getFullYear() === new Date().getFullYear() ? undefined : '2-digit',
});

function workdaysCard() {
  const off = cal.offWeekdays;
  const year = new Date().getFullYear();
  const list = cal.upcoming();
  return h('section', { class: 'card' }, h('h3', {}, 'Dias úteis'),
    h('p', { class: 'muted small' }, '"Amanhã" (no @amanhã e no botão → amanhã) vai sempre para o próximo dia útil. Toque para ligar/desligar:'),
    h('div', { class: 'kinds' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', {
      type: 'button', class: 'kind' + (off.includes(d) ? '' : ' on'), 'aria-pressed': String(!off.includes(d)),
      title: off.includes(d) ? 'Folga (toque para tornar útil)' : 'Dia útil (toque para tornar folga)',
      onclick: async () => {
        const next = off.includes(d) ? off.filter((x) => x !== d) : [...off, d].sort();
        if (next.length === 7) return toast('Pelo menos um dia da semana precisa ser útil.');
        await cal.setWeekdays(next); render();
      },
    }, WEEKDAY_NAMES[d]))),
    h('h3', { class: 'sub' }, 'Feriados e folgas'),
    list.length
      ? h('ul', { class: 'holidays' }, list.map((x) => h('li', {},
        h('span', { class: x.off ? '' : 'muted' }, `${fmtHoliday(x.day)} — ${x.label || (x.off ? 'folga' : 'dia útil (exceção)')}`),
        h('button', { class: 'link-inline', title: 'Remover', onclick: async () => { await cal.setDay(x.day, !x.off); render(); } }, 'remover'))))
      : h('p', { class: 'muted small' }, 'Nenhum. Marque um dia no topo da página do Dia, ou adicione os feriados da Baixa Saxônia (Niedersachsen):'),
    h('div', { class: 'kinds' }, [year, year + 1].map((y) => h('button', {
      type: 'button', class: 'kind',
      onclick: async () => { const n = await cal.addHolidays(lowerSaxonyHolidays(y)); toast(n ? `${n} feriado(s) de ${y} adicionado(s).` : `Os feriados de ${y} já estavam marcados.`); render(); },
    }, `+ feriados Baixa Saxônia ${y}`))));
}

function decodeURIComponentSafe(t) { try { return decodeURIComponent(t); } catch { return t; } }

function renderAccount(main) {
  main.append(h('h2', {}, 'conta'), h('p', { class: 'muted' }, state.session.user.email));
  if (!state.factors) return;

  const current = localStorage.getItem(THEME_KEY) || 'auto';
  main.append(h('section', { class: 'card' }, h('h3', {}, 'Aparência'),
    h('div', { class: 'kinds theme-choice', role: 'radiogroup', 'aria-label': 'Tema' },
      [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Preto']].map(([v, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(v === current), class: 'kind' + (v === current ? ' on' : ''),
        onclick: () => { setTheme(v); render(); },
      }, label))),
    h('p', { class: 'muted small' }, 'Automático segue o modo claro/escuro do seu aparelho. Fica salvo neste navegador.')));

  main.append(workdaysCard());

  main.append(h('section', { class: 'card' }, h('h3', {}, 'Senha'), passwordForm()));

  const mfa = h('section', { class: 'card' }, h('h3', {}, 'Verificação em 2 etapas (2FA)'));
  const verified = state.factors.totp?.[0];
  if (state.enroll) {
    const code = codeInput();
    const btn = h('button', { type: 'submit' }, 'Confirmar');
    // O Supabase devolve "data:image/svg+xml;utf-8,<svg…>" sem codificar; re-codifica para o navegador aceitar.
    let svg = state.enroll.qr;
    while (svg.startsWith('data:')) svg = decodeURIComponentSafe(svg.slice(svg.indexOf(',') + 1));
    const qr = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    mfa.append(
      h('ol', {},
        h('li', {}, 'Abra um app autenticador (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).'),
        h('li', {}, 'Escaneie o QR code abaixo. Se não der, digite a chave manualmente.'),
        h('li', {}, 'Digite o código de 6 dígitos que aparecer no app.')),
      h('img', { class: 'qr', src: qr, alt: 'QR code do 2FA', width: 180, height: 180 }),
      h('p', { class: 'muted' }, 'Chave: ', h('code', {}, state.enroll.secret)),
      h('form', {
        class: 'stack',
        onsubmit: (ev) => {
          ev.preventDefault();
          busyBtn(btn, async () => {
            const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: state.enroll.id, code: code.value.trim() });
            if (error) { toast('Código inválido. Tente de novo.'); code.select(); return; }
            state.enroll = null;
            toast('2FA ativado! A partir de agora o código será pedido ao entrar.');
            load();
          });
        },
      }, code, btn),
      h('button', { class: 'link', onclick: async () => { await sb.auth.mfa.unenroll({ factorId: state.enroll.id }); state.enroll = null; load(); } }, 'Cancelar'),
    );
    queueMicrotask(() => code.focus());
  } else if (verified) {
    mfa.append(
      h('p', {}, '✓ Ativado. Ao entrar em um dispositivo novo, o código do app será pedido.'),
      h('button', {
        class: 'secondary',
        onclick: async () => {
          if (!confirm('Desativar o 2FA? Sua conta ficará protegida só pela senha.')) return;
          const { error } = await sb.auth.mfa.unenroll({ factorId: verified.id });
          if (error) return toast('Erro: ' + error.message);
          await sb.auth.refreshSession();
          toast('2FA desativado.');
          load();
        },
      }, 'Desativar 2FA'),
    );
  } else {
    const btn = h('button', {
      onclick: () => busyBtn(btn, async () => {
        for (const f of state.factors.all || []) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
        const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Tome Nota!', issuer: 'Tome Nota!' });
        if (error) return toast('Erro: ' + error.message);
        state.enroll = { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
        render();
      }),
    }, 'Ativar 2FA');
    mfa.append(h('p', {}, 'Desativado. Recomendado: além da senha, pede um código do seu celular ao entrar.'), btn);
  }
  main.append(mfa);

  main.append(h('section', { class: 'card' }, h('h3', {}, 'Sessões'),
    h('p', { class: 'muted' }, 'Perdeu o celular ou entrou em um computador de outra pessoa? Saia de todos os dispositivos.'),
    h('button', { class: 'secondary', onclick: () => sb.auth.signOut({ scope: 'local' }) }, 'Sair deste dispositivo'),
    h('button', { class: 'secondary', onclick: () => confirm('Sair de todos os dispositivos, inclusive este?') && sb.auth.signOut({ scope: 'global' }) }, 'Sair de todos os dispositivos')));
}

// Entrada rápida + botões de tipo (usada no Dia e no Futuro).
function quickInput(main, extraHint) {
  const current = KINDS.find((k) => k.kind === state.kind) || KINDS[0];
  const input = h('input', {
    id: 'quick', class: 'quick', autocomplete: 'off', maxlength: 2000,
    placeholder: current.placeholder,
    onkeydown: async (ev) => {
      // Alt+1..3 troca o tipo sem tirar a mão do teclado.
      if (ev.altKey && /^[1-3]$/.test(ev.key)) { ev.preventDefault(); setKind(KINDS[Number(ev.key) - 1].kind, input); return; }
      if (ev.key === 'Enter' && ev.target.value.trim()) {
        const v = ev.target.value; ev.target.value = '';
        await add(v);
        document.getElementById('quick')?.focus();
      }
      if (ev.key === 'Escape') ev.target.blur();
    },
  });
  const kinds = h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Tipo' },
    KINDS.map((k, i) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(k.kind === state.kind),
      class: 'kind' + (k.kind === state.kind ? ' on' : ''),
      title: `${k.label} (Alt+${i + 1})`,
      onmousedown: (ev) => ev.preventDefault(),
      onclick: () => setKind(k.kind, input),
    }, h('span', { class: 'kind-icon' }, k.icon), k.label)),
    extraHint ? h('span', { class: 'hint' }, extraHint) : null);
  main.append(input, tags.attach(input, { extra: [{ tag: NOTE_TAG, label: '#nota → vira Nota' }] }), kinds);
}

const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Abas, na ordem do bullet journal: o Índice vem primeiro.
const TABS = [
  ['search', 'Índice', 'index'],
  ['day', 'Dia', 'day'],
  ['future', 'Futuro', 'future'],
  ['open', 'Pendentes', 'open'],
  ['notes', 'Notas', 'notes'],
];
const ICONS = {
  index: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  day: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z', 'M4 10h16', 'M8.5 3v4', 'M15.5 3v4', 'M12 14.5h.01'],
  future: ['M4 12h13', 'M12 6l6 6-6 6', 'M21 5v14'],
  open: ['M5 5h14v14H5z', 'M8.5 12.5l2.5 2.5 4.5-5.5'],
  notes: ['M6 3h9l4 4v14H6z', 'M15 3v4h4', 'M9 12h7', 'M9 16h5'],
};
function svgIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' })) svg.setAttribute(k, v);
  for (const d of ICONS[name]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}

// Faixa da semana (seg–dom) do dia aberto: hoje marcado, dias não úteis apagados.
function weekStrip() {
  const d = fromIso(state.day);
  const monday = addDays(state.day, -((d.getDay() + 6) % 7));
  const today = isoDay();
  return h('div', { class: 'week', role: 'tablist', 'aria-label': 'Semana' },
    Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((iso) => {
      const x = fromIso(iso);
      return h('button', {
        class: 'wd' + (iso === state.day ? ' on' : '') + (iso === today ? ' today' : '') + (cal.isOff(iso) ? ' off' : ''),
        title: cal.reason(iso) ? `${fmtShort(iso)} · ${cal.reason(iso)}` : fmtShort(iso),
        onclick: () => go('day', iso),
      }, h('span', { class: 'wd-name' }, WEEKDAY_NAMES[x.getDay()]), h('span', { class: 'wd-num' }, String(x.getDate())));
    }));
}

// Ordem do Dia: importantes (*) primeiro; depois agrupado por #tag (grupos e itens em ordem
// alfabética, sem tag por último; em cada grupo, as fechadas vão para o fim); notas no fim.
const byText = (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base', numeric: true });
const groupTag = (e) => [...e.tags].sort(byText)[0] || null;

// Dentro de cada grupo: abertas primeiro; fechadas (× feitas, > migradas, < agendadas) no fim.
const isClosed = (e) => e.status && e.status !== 'open';

function sortByTagThenText(list, text, closedLast = false) {
  return [...list].sort((a, b) => {
    // closedLast: o bloco inteiro é um grupo só (importantes) → fechadas no fim do bloco.
    if (closedLast && isClosed(a) !== isClosed(b)) return isClosed(a) ? 1 : -1;
    const ta = groupTag(a), tb = groupTag(b);
    if (ta !== tb) return ta == null ? 1 : tb == null ? -1 : byText(ta, tb);
    if (isClosed(a) !== isClosed(b)) return isClosed(a) ? 1 : -1;
    return byText(text(a), text(b));
  });
}

function dayRows() {
  const rows = [];
  const important = sortByTagThenText(state.entries.filter((e) => e.priority > 0), (e) => e.text, true);
  const rest = sortByTagThenText(state.entries.filter((e) => !e.priority), (e) => e.text);
  rows.push(...important.map((e) => entryRow(e)));

  // Cabeçalho discreto quando muda o grupo de tag (só se houver mais de um grupo).
  const groups = new Set(rest.map(groupTag));
  let last;
  for (const e of rest) {
    const g = groupTag(e);
    if (groups.size > 1 && g !== last) {
      rows.push(h('li', { class: 'group tag-group' }, g
        ? h('button', { class: 'tag', onclick: () => { state.tag = g; state.view = 'search'; state.query = ''; load(); } }, '#' + g)
        : 'sem tag'));
    }
    last = g;
    rows.push(entryRow(e));
  }

  if (state.dayNotes.length) {
    if (state.entries.length) rows.push(h('li', { class: 'group tag-group' }, 'notas'));
    rows.push(...[...state.dayNotes].sort((a, b) => byText(a.title || '', b.title || '')).map(noteDayRow));
  }
  return rows;
}

function render() {
  if (state.stage === 'loading') return;
  if (state.stage === 'login') return renderLogin();
  if (state.stage === 'mfa') return renderMfa();
  if (state.stage === 'recovery') return renderRecovery();

  // Abas: no computador ficam no topo; no celular, embaixo (ao alcance do polegar).
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Seções' },
    TABS.map(([v, label, icon]) => h('button', {
      class: 'tab' + (state.view === v ? ' on' : ''), 'aria-current': state.view === v ? 'page' : null,
      onclick: () => go(v, v === 'day' ? state.day : null),
    }, svgIcon(icon), h('span', {}, label))));
  const account = h('div', { class: 'account' },
    h('button', { class: 'tab' + (state.view === 'account' ? ' on' : ''), title: state.session.user.email, onclick: () => go('account') }, 'conta'),
    h('button', { class: 'tab nav-signout', title: 'Sair deste dispositivo', onclick: () => sb.auth.signOut({ scope: 'local' }) }, 'sair'));

  const main = h('main', {});

  if (state.view === 'day') {
    const isToday = state.day === isoDay();
    main.append(
      h('div', { class: 'dayhead' },
        h('button', { title: 'Dia anterior ( [ )', onclick: () => go('day', addDays(state.day, -1)) }, '‹'),
        h('h2', {}, fmtLong(state.day)),
        h('button', { title: 'Próximo dia ( ] )', onclick: () => go('day', addDays(state.day, 1)) }, '›'),
        !isToday ? h('button', { class: 'today', onclick: () => go('day', isoDay()) }, 'hoje') : null,
      ),
    );
    main.append(weekStrip());
    const why = cal.reason(state.day);
    main.append(h('div', { class: 'daystatus' + (why ? ' off' : '') },
      why ? `Dia não útil · ${why}` : null,
      h('button', {
        class: 'link-inline',
        onclick: async () => {
          if (why) await cal.setDay(state.day, false);
          else {
            const label = prompt('Marcar como dia não útil. Nome (opcional), ex.: "Natal", "férias":', '');
            if (label === null) return;
            await cal.setDay(state.day, true, label.trim().slice(0, 100));
          }
          render();
        },
      }, why ? 'tornar dia útil' : 'marcar como dia não útil')));
    if (state.overdue) {
      main.append(h('div', { class: 'banner' },
        `${state.overdue} tarefa(s) aberta(s) de dias anteriores. `,
        h('button', { onclick: migrateOverdue }, 'Migrar todas para hoje')));
    }
    quickInput(main);
    main.append(state.entries.length || state.dayNotes.length
      ? h('ul', { class: 'entries' }, dayRows())
      : h('p', { class: 'empty' }, state.busy ? '' : 'Página em branco. Comece a anotar.'));
  }

  if (state.view === 'future') {
    main.append(h('h2', { class: 'view-title' }, 'futuro'));
    quickInput(main, 'sem @data → próximo mês');
    const list = h('ul', { class: 'entries' });
    let lastMonth = null;
    for (const e of state.entries) {
      const m = firstOfMonth(e.day);
      if (m !== lastMonth) {
        lastMonth = m;
        const count = state.entries.filter((x) => firstOfMonth(x.day) === m).length;
        list.append(h('li', { class: 'group month' }, capitalize(monthLabel(m)), h('span', { class: 'count' }, count)));
      }
      list.append(entryRow(e, 'inMonth'));
    }
    main.append(state.entries.length ? list
      : h('p', { class: 'empty' }, state.busy ? '' : 'Nada agendado. Use @dez, @25/12 ou "agendar ▸" numa tarefa.'));
  }

  if (state.view === 'open') {
    main.append(h('h2', { class: 'view-title' }, 'tarefas pendentes'));
    if (state.tag) main.append(h('p', {}, h('button', { class: 'tag', onclick: () => { state.tag = null; load(); } }, `#${state.tag} ✕`)));
    let lastKey = null;
    const list = h('ul', { class: 'entries' });
    const today = isoDay();
    for (const e of state.entries) {
      const key = e.day + (e.month_only ? 'm' : '');
      if (key !== lastKey) {
        lastKey = key;
        const late = e.month_only ? e.day < firstOfMonth(today) : e.day < today;
        const label = e.month_only ? `${monthLabel(e.day)} · sem dia` : e.day === today ? 'hoje' : fmtShort(e.day);
        list.append(h('li', { class: 'group' + (late ? ' late' : '') }, label));
      }
      list.append(entryRow(e));
    }
    main.append(state.entries.length ? list : h('p', { class: 'empty' }, state.busy ? '' : 'Nada pendente. 🎉'));
  }

  if (state.view === 'export') exporter.render(main, () => go('search'));

  if (state.view === 'search') {
    main.append(h('div', { class: 'index-head' },
      h('h2', {}, 'índice'),
      h('button', { class: 'primary', title: 'Exportar notas e tarefas em Markdown', onclick: () => go('export') }, 'Exportar ↓')));
    let timer;
    const input = h('input', {
      id: 'quick', class: 'quick', type: 'search', placeholder: 'Buscar em tudo…', value: state.query,
      oninput: (ev) => { clearTimeout(timer); timer = setTimeout(() => { state.query = ev.target.value; load(); }, 250); },
    });
    main.append(input);
    if (state.tag) main.append(h('p', {}, h('button', { class: 'tag', onclick: () => { state.tag = null; load(); } }, `#${state.tag} ✕`)));
    if (state.searchNotes.length) {
      main.append(h('h3', { class: 'section' }, 'Notas'), h('ul', { class: 'notes' }, state.searchNotes.map(notes.noteRow)));
    }
    if (state.entries.length && state.searchNotes.length) main.append(h('h3', { class: 'section' }, 'Diário'));
    main.append(h('ul', { class: 'entries' }, state.entries.map((e) => entryRow(e, 'full'))));
    if ((state.query.trim() || state.tag) && !state.entries.length && !state.searchNotes.length && !state.busy) {
      main.append(h('p', { class: 'empty' }, 'Nada encontrado.'));
    }
    if (!state.query.trim() && !state.tag) {
      // Índice do bullet journal: coleções (tags), notas fixadas e o que está no futuro.
      const all = tags.list();
      main.append(h('h3', { class: 'section' }, 'Coleções'),
        all.length
          ? h('div', { class: 'tag-cloud' }, all.map(([t, n]) =>
            h('button', { class: 'tag-pill', onclick: () => { state.tag = t; load(); } }, '#' + t, h('span', { class: 'count' }, n))))
          : h('p', { class: 'muted' }, 'Nenhuma coleção ainda. Use #algo nas suas anotações e notas.'));
      main.append(h('h3', { class: 'section' }, 'Notas fixadas'),
        state.pinnedNotes.length
          ? h('ul', { class: 'notes' }, state.pinnedNotes.map(notes.noteRow))
          : h('p', { class: 'muted' }, 'Nenhuma. Use "fixar" numa nota para ela aparecer aqui.'));
      main.append(h('h3', { class: 'section' }, 'Futuro'),
        state.futureSummary.length
          ? h('ul', { class: 'index-list' }, state.futureSummary.map(([m, n]) =>
            h('li', {}, h('button', { onclick: () => go('future') }, capitalize(monthLabel(m)), h('span', { class: 'count' }, n)))))
          : h('p', { class: 'muted' }, 'Nada agendado.'));
    }
    queueMicrotask(() => {
      if (document.activeElement?.id !== 'quick') { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
  }

  if (state.view === 'notes') notes.renderView(main);
  if (state.view === 'account') renderAccount(main);

  app.replaceChildren(h('header', {}, h('span', { class: 'logo' }, 'Tome Nota!'), nav, account), main);
}

// ---------- Atalhos ----------
document.addEventListener('keydown', (ev) => {
  if (state.stage !== 'app' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const k = ev.key;
  if (k === '/' || k === 'n') { ev.preventDefault(); if (state.view !== 'day' && k === 'n') go('day'); setTimeout(() => document.getElementById('quick')?.focus()); }
  else if (k === '[') go('day', addDays(state.day, -1));
  else if (k === ']') go('day', addDays(state.day, 1));
  else if (k === 't') go('day', isoDay());
  else if (k === 'p') go('open');
  else if (k === 's' || k === 'i') { ev.preventDefault(); go('search'); }
  else if (k === 'f') go('future');
  else if (k === 'a') go('notes');
});

// Não perder o que foi digitado numa nota ao fechar/trocar de aba.
window.addEventListener('beforeunload', (ev) => {
  if (notes.hasPending()) { notes.flush(); ev.preventDefault(); ev.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') notes.flush(); });

// ---------- Boot ----------
// Não chamar o Supabase direto dentro do callback (pode travar): agenda com setTimeout.
sb.auth.onAuthStateChange((event, session) => {
  state.session = session;
  if (event === 'PASSWORD_RECOVERY') state.recovery = true;
  if (event === 'SIGNED_OUT') { state.recovery = false; state.view = 'day'; state.enroll = null; state.noteOpen = false; state.notes = null; }
  setTimeout(refreshAuth);
});
