import './style.css';
import { createClient } from '@supabase/supabase-js';
import { parseEntry, isoDay, addDays, fromIso } from './parse.js';

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
window.addEventListener('error', (e) => e.error?.message !== 'missing config' && fatal('Erro', String(e.error?.stack || e.message)));
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

const app = document.getElementById('app');
const state = {
  session: null,
  view: 'day',          // day | open | search
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

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

function check({ error }) {
  if (error) { toast(error.message); throw error; }
}

// ---------- Dados ----------
async function load() {
  state.busy = true;
  let q = sb.from('entries').select('*');
  if (state.view === 'day') {
    q = q.eq('day', state.day).order('created_at');
  } else if (state.view === 'open') {
    q = q.eq('kind', 'task').eq('status', 'open').order('day').order('priority', { ascending: false }).order('created_at');
    if (state.tag) q = q.contains('tags', [state.tag]);
  } else {
    const term = state.query.trim();
    if (!term && !state.tag) { state.entries = []; state.busy = false; return render(); }
    if (term) q = q.ilike('text', `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    if (state.tag) q = q.contains('tags', [state.tag]);
    q = q.order('day', { ascending: false }).limit(200);
  }
  const res = await q;
  check(res);
  state.entries = res.data;

  if (state.view === 'day' && state.day === isoDay()) {
    const o = await sb.from('entries').select('id', { count: 'exact', head: true })
      .eq('kind', 'task').eq('status', 'open').lt('day', state.day);
    state.overdue = o.count || 0;
  } else state.overdue = 0;

  state.busy = false;
  render();
}

async function add(raw) {
  const e = parseEntry(raw, state.view === 'day' ? state.day : isoDay());
  if (!e.text) return;
  check(await sb.from('entries').insert(e));
  if (state.view === 'day' && e.day !== state.day) toast(`Anotado para ${fmtShort(e.day)}`);
  await load();
}

async function update(id, patch) {
  check(await sb.from('entries').update(patch).eq('id', id));
  await load();
}

async function remove(id) {
  check(await sb.from('entries').delete().eq('id', id));
  await load();
}

// Migração estilo bullet journal: original fica ">" e uma cópia vai para o dia destino.
async function migrate(entries, target) {
  if (!entries.length) return;
  check(await sb.from('entries').insert(entries.map((e) => ({
    kind: e.kind, text: e.text, tags: e.tags, priority: e.priority, day: target,
  }))));
  check(await sb.from('entries').update({ status: 'migrated' }).in('id', entries.map((e) => e.id)));
  await load();
}

async function migrateOverdue() {
  const res = await sb.from('entries').select('*').eq('kind', 'task').eq('status', 'open').lt('day', isoDay());
  check(res);
  await migrate(res.data, isoDay());
  toast(`${res.data.length} tarefa(s) migrada(s) para hoje`);
}

// ---------- Render ----------
const BULLET = {
  task: { open: '•', done: '×', migrated: '>', cancelled: '•' },
  note: { open: '–', done: '–', migrated: '>', cancelled: '–' },
  event: { open: '○', done: '◉', migrated: '>', cancelled: '○' },
};

function entryRow(e, showDay) {
  const toggle = () => {
    if (e.kind !== 'task' || e.status === 'migrated') return;
    update(e.id, { status: e.status === 'done' ? 'open' : 'done' });
  };

  let body;
  if (state.editing === e.id) {
    const input = h('input', {
      class: 'edit', value: e.text, maxlength: 2000,
      onkeydown: (ev) => {
        if (ev.key === 'Enter') { state.editing = null; const t = ev.target.value.trim(); t && t !== e.text ? update(e.id, { text: t }) : render(); }
        if (ev.key === 'Escape') { state.editing = null; render(); }
      },
      onblur: () => { if (state.editing === e.id) { state.editing = null; render(); } },
    });
    queueMicrotask(() => { input.focus(); input.select(); });
    body = input;
  } else {
    body = h('span', { class: 'text', ondblclick: () => { state.editing = e.id; render(); } }, e.text);
  }

  const tomorrow = addDays(isoDay(), 1);
  return h('li', { class: `entry ${e.kind} ${e.status} p${e.priority}` },
    h('button', { class: 'bullet', title: e.kind === 'task' ? 'Concluir / reabrir' : e.kind, onclick: toggle }, BULLET[e.kind][e.status]),
    h('div', { class: 'body' },
      body,
      e.tags.length ? h('span', { class: 'tags' }, e.tags.map((t) =>
        h('button', { class: 'tag', onclick: () => { state.tag = t; state.view = 'search'; state.query = ''; load(); } }, '#' + t))) : null,
      showDay ? h('button', { class: 'day-link', onclick: () => go('day', e.day) }, fmtShort(e.day)) : null,
    ),
    h('span', { class: 'actions' },
      e.kind === 'task' && e.status === 'open' && e.day !== isoDay()
        ? h('button', { title: 'Migrar para hoje', onclick: () => migrate([e], isoDay()) }, '→ hoje') : null,
      e.kind === 'task' && e.status === 'open' && e.day !== tomorrow
        ? h('button', { title: 'Migrar para amanhã', onclick: () => migrate([e], tomorrow) }, '→ amanhã') : null,
      h('button', { title: 'Editar', onclick: () => { state.editing = e.id; render(); } }, 'editar'),
      h('button', { title: 'Apagar', class: 'danger', onclick: () => confirm('Apagar?') && remove(e.id) }, 'apagar'),
    ),
  );
}

function go(view, day) {
  state.view = view;
  if (day) state.day = day;
  if (view !== 'search') state.tag = view === 'open' ? state.tag : null;
  state.editing = null;
  load();
}

function renderLogin() {
  let sent = false;
  const msg = h('p', { class: 'muted' }, 'Entre com seu e-mail. Enviaremos um link de acesso (sem senha).');
  const email = h('input', { type: 'email', required: true, placeholder: 'voce@exemplo.com', autocomplete: 'email' });
  const btn = h('button', { type: 'submit' }, 'Enviar link');
  const form = h('form', {
    class: 'login',
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (sent) return;
      btn.disabled = true;
      const { error } = await sb.auth.signInWithOtp({
        email: email.value.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      });
      btn.disabled = false;
      if (error) { msg.textContent = 'Não foi possível enviar: ' + error.message; return; }
      sent = true;
      msg.textContent = 'Pronto! Confira seu e-mail e clique no link.';
    },
  }, h('h1', {}, 'tomenota'), msg, email, btn);
  app.replaceChildren(form);
  email.focus();
}

function render() {
  if (!state.session) return renderLogin();

  const nav = h('nav', {},
    ...[['day', 'Dia'], ['open', 'Pendentes'], ['search', 'Busca']].map(([v, label]) =>
      h('button', { class: state.view === v ? 'on' : '', onclick: () => go(v, v === 'day' ? state.day : null) }, label)),
    h('button', { class: 'logout', title: state.session.user.email, onclick: () => sb.auth.signOut() }, 'sair'),
  );

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
    if (state.overdue) {
      main.append(h('div', { class: 'banner' },
        `${state.overdue} tarefa(s) aberta(s) de dias anteriores. `,
        h('button', { onclick: migrateOverdue }, 'Migrar todas para hoje')));
    }
    const input = h('input', {
      id: 'quick', class: 'quick', autocomplete: 'off', maxlength: 2000,
      placeholder: 'Anote algo…   - nota · o evento · #tag · ! · @amanhã',
      onkeydown: async (ev) => {
        if (ev.key === 'Enter' && ev.target.value.trim()) {
          const v = ev.target.value; ev.target.value = '';
          await add(v);
          document.getElementById('quick')?.focus();
        }
        if (ev.key === 'Escape') ev.target.blur();
      },
    });
    main.append(input);
    const list = h('ul', { class: 'entries' }, state.entries.map((e) => entryRow(e, false)));
    main.append(state.entries.length ? list : h('p', { class: 'empty' }, state.busy ? '' : 'Página em branco. Comece a anotar.'));
  }

  if (state.view === 'open') {
    main.append(h('h2', {}, 'Tarefas pendentes'));
    if (state.tag) main.append(h('p', {}, h('button', { class: 'tag', onclick: () => { state.tag = null; load(); } }, `#${state.tag} ✕`)));
    let lastDay = null;
    const list = h('ul', { class: 'entries' });
    const today = isoDay();
    for (const e of state.entries) {
      if (e.day !== lastDay) {
        lastDay = e.day;
        list.append(h('li', { class: 'group' + (e.day < today ? ' late' : '') }, e.day === today ? 'hoje' : fmtShort(e.day)));
      }
      list.append(entryRow(e, false));
    }
    main.append(state.entries.length ? list : h('p', { class: 'empty' }, state.busy ? '' : 'Nada pendente. 🎉'));
  }

  if (state.view === 'search') {
    let timer;
    const input = h('input', {
      id: 'quick', class: 'quick', type: 'search', placeholder: 'Buscar…', value: state.query,
      oninput: (ev) => { clearTimeout(timer); timer = setTimeout(() => { state.query = ev.target.value; load(); }, 250); },
    });
    main.append(input);
    if (state.tag) main.append(h('p', {}, h('button', { class: 'tag', onclick: () => { state.tag = null; load(); } }, `#${state.tag} ✕`)));
    main.append(h('ul', { class: 'entries' }, state.entries.map((e) => entryRow(e, true))));
    queueMicrotask(() => {
      if (document.activeElement?.id !== 'quick') { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
  }

  app.replaceChildren(h('header', {}, h('span', { class: 'logo' }, 'tomenota'), nav), main);
}

// ---------- Atalhos ----------
document.addEventListener('keydown', (ev) => {
  if (!state.session || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const k = ev.key;
  if (k === '/' || k === 'n') { ev.preventDefault(); if (state.view !== 'day' && k === 'n') go('day'); setTimeout(() => document.getElementById('quick')?.focus()); }
  else if (k === '[') go('day', addDays(state.day, -1));
  else if (k === ']') go('day', addDays(state.day, 1));
  else if (k === 't') go('day', isoDay());
  else if (k === 'p') go('open');
  else if (k === 's') { ev.preventDefault(); go('search'); }
});

// ---------- Boot ----------
let booted = false;
sb.auth.onAuthStateChange((_event, session) => {
  const changed = !booted || !!session !== !!state.session;
  booted = true;
  state.session = session;
  if (changed) setTimeout(() => (session ? load() : render()));
});
