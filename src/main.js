import './style.css';
import { createClient } from '@supabase/supabase-js';
import { parseEntry, splitTitle, isoDay, addDays, fromIso, NOTEBOOK_TAG } from './parse.js';
import { createTags } from './tags.js';
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

const app = document.getElementById('app');

// Não rodar dentro de iframe de outro site (proteção contra clickjacking; o GitHub Pages não deixa mandar header para isso).
if (window.top !== window.self) {
  app.textContent = 'Abra o tomenota diretamente: ' + location.href;
  throw new Error('framed');
}
const state = {
  session: null,
  stage: 'loading',     // loading | login | mfa | recovery | app
  recovery: false,
  view: 'day',          // day | open | notes | search | account
  kind: 'task',         // tipo escolhido nos botões: task | event | note | notebook
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

const notes = createNotes({
  sb, h, toast, check, state, tags,
  render: () => render(),
  openTag: (t) => { state.tag = t; state.query = ''; go('search'); },
});

// ---------- Dados ----------
async function load() {
  if (state.view === 'account') {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) toast(error.message);
    state.factors = data || { all: [], totp: [] };
    return render();
  }
  if (state.view === 'notes') {
    if (!state.noteOpen) await notes.loadList();
    return render();
  }
  state.busy = true;
  let q = sb.from('entries').select('*');
  if (state.view === 'day') {
    q = q.eq('day', state.day).order('created_at');
  } else if (state.view === 'open') {
    q = q.eq('kind', 'task').eq('status', 'open').order('day').order('priority', { ascending: false }).order('created_at');
    if (state.tag) q = q.contains('tags', [state.tag]);
  } else {
    const term = state.query.trim();
    if (!term && !state.tag) { state.entries = []; state.searchNotes = []; state.busy = false; return render(); }
    state.searchNotes = await notes.search(term, state.tag);
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

// Texto da entrada rápida → nota do caderno. "Título: corpo"; as #tags vão no fim do corpo.
async function sendToNotebook(text, entryTags) {
  const { title, body } = splitTitle(text);
  const tagLine = entryTags.map((t) => '#' + t).join(' ');
  const note = await notes.quickCreate({ title, body: [body, tagLine].filter(Boolean).join('\n\n') });
  toast(`Salvo em Notas: ${title}`, { label: 'abrir', fn: () => notes.open(note.id) });
  tags.refresh();
  return note;
}

async function add(raw) {
  const e = parseEntry(raw, state.view === 'day' ? state.day : isoDay(), state.kind);
  if (!e.text) return;
  if (e.kind === 'notebook') { await sendToNotebook(e.text, e.tags); return; }
  check(await sb.from('entries').insert(e));
  if (state.view === 'day' && e.day !== state.day) toast(`Anotado para ${fmtShort(e.day)}`);
  if (e.tags.length) tags.refresh();
  await load();
}

// Trocar o tipo de uma entrada já anotada (ou movê-la para o caderno de Notas).
async function changeKind(e, kind) {
  if (kind === e.kind) return;
  if (kind === 'notebook') {
    await sendToNotebook(e.text, e.tags);
    check(await sb.from('entries').delete().eq('id', e.id));
    return load();
  }
  await update(e.id, { kind, status: e.status === 'migrated' ? 'migrated' : 'open' });
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
const KINDS = [
  { kind: 'task', icon: '•', label: 'Tarefa', placeholder: 'Nova tarefa…   #tag · ! prioridade · @amanhã' },
  { kind: 'event', icon: '○', label: 'Evento', placeholder: 'Novo evento…   @sex · #tag' },
  { kind: 'note', icon: '–', label: 'Nota', placeholder: 'Nota rápida no diário…   #tag' },
  { kind: 'notebook', icon: '📝', label: 'Notas', placeholder: 'Vai direto para Notas…   Título: texto · #tag' },
];

function kindSelect(e) {
  const sel = h('select', {
    class: 'kind-select', title: 'Mudar tipo',
    onchange: (ev) => changeKind(e, ev.target.value),
  }, KINDS.map((k) => h('option', { value: k.kind }, k.kind === 'notebook' ? '📝 mover p/ Notas' : `${k.icon} ${k.label.toLowerCase()}`)));
  sel.value = e.kind;
  return sel;
}

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
  // tabindex -1: tocar na linha (celular) a "seleciona" e mostra as ações.
  return h('li', { class: `entry ${e.kind} ${e.status} p${e.priority}`, tabindex: '-1' },
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
      kindSelect(e),
      h('button', { title: 'Editar', onclick: () => { state.editing = e.id; render(); } }, 'editar'),
      h('button', { title: 'Apagar', class: 'danger', onclick: () => confirm('Apagar?') && remove(e.id) }, 'apagar'),
    ),
  );
}

async function go(view, day) {
  if (state.noteOpen) { await notes.close(); tags.refresh(); }
  state.view = view;
  if (day) state.day = day;
  if (view !== 'search') state.tag = view === 'open' ? state.tag : null;
  state.editing = null;
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
  return h('div', { class: 'login' }, h('h1', {}, 'tomenota'), title ? h('h2', {}, title) : null, msg, ...fields);
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
    load();
    tags.refresh().then(() => { if (state.view === 'search' && !state.query.trim() && !state.tag) render(); });
  } else render();
}

// ---------- Conta ----------
function decodeURIComponentSafe(t) { try { return decodeURIComponent(t); } catch { return t; } }

function renderAccount(main) {
  main.append(h('h2', {}, 'conta'), h('p', { class: 'muted' }, state.session.user.email));
  if (!state.factors) return;

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
        const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'tomenota', issuer: 'tomenota' });
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
    h('button', { class: 'secondary', onclick: () => confirm('Sair de todos os dispositivos, inclusive este?') && sb.auth.signOut({ scope: 'global' }) }, 'Sair de todos os dispositivos')));
}

function render() {
  if (state.stage === 'loading') return;
  if (state.stage === 'login') return renderLogin();
  if (state.stage === 'mfa') return renderMfa();
  if (state.stage === 'recovery') return renderRecovery();

  const nav = h('nav', {},
    ...[['day', 'Dia'], ['open', 'Pendentes'], ['notes', 'Notas'], ['search', 'Busca']].map(([v, label]) =>
      h('button', { class: state.view === v ? 'on' : '', onclick: () => go(v, v === 'day' ? state.day : null) }, label)),
    h('button', { class: 'logout' + (state.view === 'account' ? ' on' : ''), title: state.session.user.email, onclick: () => go('account') }, 'conta'),
    h('button', { title: 'Sair deste dispositivo', onclick: () => sb.auth.signOut({ scope: 'local' }) }, 'sair'),
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
    const current = KINDS.find((k) => k.kind === state.kind);
    const input = h('input', {
      id: 'quick', class: 'quick', autocomplete: 'off', maxlength: 2000,
      placeholder: current.placeholder,
      onkeydown: async (ev) => {
        // Alt+1..4 troca o tipo sem tirar a mão do teclado.
        if (ev.altKey && /^[1-4]$/.test(ev.key)) { ev.preventDefault(); setKind(KINDS[Number(ev.key) - 1].kind, input); return; }
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
        class: 'kind' + (k.kind === state.kind ? ' on' : '') + (k.kind === 'notebook' ? ' nb' : ''),
        title: `${k.label} (Alt+${i + 1})`,
        onmousedown: (ev) => ev.preventDefault(),
        onclick: () => setKind(k.kind, input),
      }, h('span', { class: 'kind-icon' }, k.icon), k.label)));
    main.append(input,
      tags.attach(input, { extra: [{ tag: NOTEBOOK_TAG, label: '#nota → vai para Notas' }] }),
      kinds);
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
    if (state.searchNotes.length) {
      main.append(h('h3', { class: 'section' }, 'Notas'), h('ul', { class: 'notes' }, state.searchNotes.map(notes.noteRow)));
    }
    if (state.entries.length && state.searchNotes.length) main.append(h('h3', { class: 'section' }, 'Diário'));
    main.append(h('ul', { class: 'entries' }, state.entries.map((e) => entryRow(e, true))));
    if ((state.query.trim() || state.tag) && !state.entries.length && !state.searchNotes.length && !state.busy) {
      main.append(h('p', { class: 'empty' }, 'Nada encontrado.'));
    }
    if (!state.query.trim() && !state.tag) {
      const all = tags.list();
      main.append(h('h3', { class: 'section' }, 'Tags'),
        all.length
          ? h('div', { class: 'tag-cloud' }, all.map(([t, n]) =>
            h('button', { class: 'tag-pill', onclick: () => { state.tag = t; load(); } }, '#' + t, h('span', { class: 'count' }, n))))
          : h('p', { class: 'muted' }, 'Nenhuma tag ainda. Use #algo nas suas anotações e notas.'));
    }
    queueMicrotask(() => {
      if (document.activeElement?.id !== 'quick') { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
  }

  if (state.view === 'notes') notes.renderView(main);
  if (state.view === 'account') renderAccount(main);

  app.replaceChildren(h('header', {}, h('span', { class: 'logo' }, 'tomenota'), nav), main);
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
  else if (k === 's') { ev.preventDefault(); go('search'); }
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
