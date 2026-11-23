// Cópia local (offline-first) das tarefas/eventos e notas + fila de alterações.
//
// - O app SEMPRE lê da cópia local (memória + IndexedDB): abre na hora, com ou sem internet.
// - Toda escrita muda a cópia local na hora e entra numa fila (outbox).
// - Com conexão, a fila é enviada em ordem e depois a cópia é atualizada com o servidor (pull).
// - Conflito em nota (editada offline aqui e, nesse meio tempo, em outro aparelho):
//   a versão do servidor fica, e a deste aparelho vira uma cópia "(conflito)". Nada se perde.
//   Cada linha guarda em _srv o updated_at da última versão do servidor que este aparelho conhece;
//   conflito = o servidor tem uma versão mais nova que _srv (comparação servidor × servidor).
// - Tarefas: vale a última alteração.

const TABLES = ['entries', 'notes'];
const PAGE = 1000;

const DEFAULTS = {
  entries: { kind: 'task', status: 'open', priority: 0, tags: [], month_only: false, note_id: null, started_at: null },
  notes: { title: '', body: '', tags: [], pinned: false, day: null },
};

// ---------- IndexedDB (mínimo necessário, sem dependências) ----------
function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of TABLES) if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function run(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

const isNetworkFailure = (res) => !!res?.error && (res.status === 0 || /fetch|network|load failed|timed? ?out/i.test(String(res.error.message)) && !res.error.code);
const time = (v) => (v ? new Date(v).getTime() : 0);

export function createStore({ sb, toast, friendlyError, onChange, onStatus }) {
  const mem = { entries: new Map(), notes: new Map() };
  let db = null;
  let dbName = null;
  let outbox = [];            // [{ key, op }]
  let reachable = true;       // false depois de uma falha de rede (até a conexão voltar)
  let syncing = false;
  let lastSync = null;
  let opened = false;

  const online = () => navigator.onLine && reachable;
  const status = () => onStatus?.({ online: online(), pending: outbox.length, syncing, lastSync, opened });

  // ---------- abrir / fechar ----------
  async function open(userId) {
    const name = `tomenota-${userId}`;
    if (dbName === name && db) return;
    close();
    dbName = name;
    db = await openDb(name);
    for (const t of TABLES) {
      const all = await run(db, t, 'readonly', (s) => reqP(s.getAll()));
      mem[t] = new Map(all.map((r) => [r.id, r]));
    }
    const keys = await run(db, 'outbox', 'readonly', (s) => reqP(s.getAllKeys()));
    const ops = await run(db, 'outbox', 'readonly', (s) => reqP(s.getAll()));
    outbox = keys.map((key, i) => ({ key, op: ops[i] }));
    lastSync = await run(db, 'meta', 'readonly', (s) => reqP(s.get('lastSync')));
    opened = true;
    status();
  }

  function close() {
    db?.close();
    db = null; dbName = null; opened = false;
    mem.entries = new Map(); mem.notes = new Map(); outbox = []; lastSync = null;
  }

  // Apaga a cópia local deste usuário (ao sair).
  async function wipe() {
    const name = dbName;
    close();
    if (name) await new Promise((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
    status();
  }

  const hasData = () => mem.entries.size + mem.notes.size > 0 || !!lastSync;

  // ---------- leitura ----------
  const rows = (t) => [...mem[t].values()];
  const get = (t, id) => mem[t].get(id) || null;

  // ---------- escrita ----------
  const nowIso = () => new Date().toISOString();
  const persist = (t, list) => run(db, t, 'readwrite', (s) => { for (const r of list) s.put(r); });

  async function enqueue(op) {
    op.queuedOffline = !online();
    // Várias edições seguidas da mesma linha (ex.: digitar numa nota offline) viram uma só.
    const last = outbox[outbox.length - 1];
    if (last && !syncing && last.op.op === 'update' && op.op === 'update' && last.op.t === op.t
      && last.op.ids.length === 1 && op.ids.length === 1 && last.op.ids[0] === op.ids[0]) {
      Object.assign(last.op.patch, op.patch);
      last.op.queuedOffline = last.op.queuedOffline || op.queuedOffline;
      await run(db, 'outbox', 'readwrite', (s) => s.put(last.op, last.key));
    } else {
      const key = await run(db, 'outbox', 'readwrite', (s) => reqP(s.add(op)));
      outbox.push({ key, op });
    }
    status();
    flush();
  }

  // send: só os campos que o app definiu (o servidor completa o resto) — assim funciona
  // mesmo que alguma migração opcional ainda não tenha sido rodada.
  async function insert(t, data) {
    const list = [].concat(data).map((r) => {
      const at = r.created_at || nowIso();
      const send = { ...r, id: r.id || crypto.randomUUID(), created_at: at };
      return { local: { ...DEFAULTS[t], ...send, updated_at: at, _srv: null }, send };
    });
    for (const { local } of list) mem[t].set(local.id, local);
    await persist(t, list.map((x) => x.local));
    await enqueue({ t, op: 'upsert', rows: list.map((x) => x.send) });
    onChange?.();
    return Array.isArray(data) ? list.map((x) => x.local) : list[0].local;
  }

  async function update(t, ids, patch) {
    ids = [].concat(ids).filter((id) => mem[t].has(id));
    if (!ids.length) return;
    const at = nowIso();
    for (const id of ids) Object.assign(mem[t].get(id), patch, { updated_at: at });
    await persist(t, ids.map((id) => mem[t].get(id)));
    await enqueue({ t, op: 'update', ids, patch: { ...patch } });
    onChange?.();
  }

  async function remove(t, ids) {
    ids = [].concat(ids);
    for (const id of ids) mem[t].delete(id);
    await run(db, t, 'readwrite', (s) => { for (const id of ids) s.delete(id); });
    if (t === 'notes') {
      // Espelha o "on delete set null" do banco: tarefas perdem a ligação com a nota apagada.
      const touched = rows('entries').filter((e) => ids.includes(e.note_id));
      for (const e of touched) e.note_id = null;
      if (touched.length) await persist('entries', touched);
    }
    await enqueue({ t, op: 'delete', ids });
    onChange?.();
  }

  // ---------- sincronização ----------
  // Guarda a versão do servidor devolvida após cada envio (evita falsos conflitos depois).
  async function remember(t, res) {
    if (res?.error || !Array.isArray(res?.data) || !db) return;
    const touched = [];
    for (const r of res.data) { const row = mem[t].get(r.id); if (row) { row._srv = r.updated_at; touched.push(row); } }
    if (touched.length) await persist(t, touched);
  }

  async function send(op) {
    const { t } = op;
    if (op.op === 'upsert') { const res = await sb.from(t).upsert(op.rows).select('id, updated_at'); await remember(t, res); return res; }
    if (op.op === 'delete') return sb.from(t).delete().in('id', op.ids);
    if (op.op === 'update') {
      let ids = op.ids;
      if (t === 'notes' && op.queuedOffline) {
        // Conflito? Se o servidor tem uma versão mais nova que a última que este aparelho conhecia
        // (_srv), alguém editou em outro lugar: guarda a nossa como cópia e mantém a do servidor.
        // Nota criada offline (_srv vazio) não tem como conflitar.
        const known = ids.filter((id) => mem.notes.get(id)?._srv);
        const cur = known.length ? await sb.from('notes').select('id, updated_at').in('id', known) : { data: [] };
        if (cur.error) return cur;
        const changed = new Set(cur.data.filter((n) => time(n.updated_at) > time(mem.notes.get(n.id)?._srv)).map((n) => n.id));
        for (const id of changed) {
          const mine = mem.notes.get(id);
          if (!mine) continue;
          const copy = { id: crypto.randomUUID(), title: `${mine.title || 'Sem título'} (conflito)`, body: mine.body, tags: mine.tags, day: mine.day };
          const r = await sb.from('notes').upsert(copy);
          if (r.error) return r;
          // A versão do servidor volta para cá no próximo pull (a nossa edição fica na cópia).
          toast?.(`A nota "${mine.title || 'Sem título'}" foi editada em outro aparelho. Sua versão foi salva como cópia "(conflito)".`);
        }
        ids = ids.filter((id) => !changed.has(id));
        if (!ids.length) return { error: null };
      }
      const res = await sb.from(t).update(op.patch).in('id', ids).select('id, updated_at');
      await remember(t, res);
      return res;
    }
    return { error: null };
  }

  let flushing = null;
  function flush() {
    if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }
  async function doFlush() {
    if (!db || !online() || !outbox.length) return;
    syncing = true; status();
    let resync = false;
    try {
      while (outbox.length && db) {
        const { key, op } = outbox[0];
        const res = await send(op);
        if (isNetworkFailure(res)) {
          reachable = false;
          // A conexão caiu: o que sobrou na fila passa a contar como "feito offline" (checa conflito ao enviar).
          for (const x of outbox) if (!x.op.queuedOffline) { x.op.queuedOffline = true; await run(db, 'outbox', 'readwrite', (st) => st.put(x.op, x.key)); }
          break;
        }
        if (res?.error) {
          // O servidor recusou (ex.: migração não rodada, regra violada): avisa, descarta e ressincroniza.
          toast?.(friendlyError ? friendlyError(res.error) : res.error.message);
          resync = true;
        }
        await run(db, 'outbox', 'readwrite', (s) => s.delete(key));
        outbox.shift();
        status();
      }
    } finally {
      syncing = false; status();
    }
    if (resync) pull();
  }

  async function fetchAll(t) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const res = await sb.from(t).select('*').order('id').range(from, from + PAGE - 1);
      if (res.error) return res;
      out.push(...res.data);
      if (res.data.length < PAGE) return { data: out };
    }
  }

  let pulling = null;
  function pull() {
    if (!pulling) pulling = doPull().finally(() => { pulling = null; });
    return pulling;
  }
  async function doPull() {
    if (!db || !online()) return false;
    await flush();
    if (outbox.length || !db) return false;          // ainda há alterações a enviar: não sobrescreve
    syncing = true; status();
    try {
      const fresh = {};
      for (const t of TABLES) {
        const res = await fetchAll(t);
        if (isNetworkFailure(res)) { reachable = false; return false; }
        if (res.error) { toast?.(friendlyError ? friendlyError(res.error) : res.error.message); return false; }
        fresh[t] = res.data;
      }
      if (outbox.length || !db) return false;         // escreveu algo enquanto baixava: tenta de novo depois
      for (const t of TABLES) {
        for (const r of fresh[t]) r._srv = r.updated_at;
        mem[t] = new Map(fresh[t].map((r) => [r.id, r]));
        await run(db, t, 'readwrite', (s) => { s.clear(); for (const r of fresh[t]) s.put(r); });
      }
      lastSync = nowIso();
      await run(db, 'meta', 'readwrite', (s) => s.put(lastSync, 'lastSync'));
      onChange?.({ fromServer: true });
      return true;
    } finally {
      syncing = false; status();
    }
  }

  // Conexão voltou / app voltou ao primeiro plano: envia a fila e atualiza.
  function wake() {
    reachable = true;
    status();
    pull();
  }
  window.addEventListener('online', wake);
  window.addEventListener('offline', status);
  let lastWake = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastWake > 30000) { lastWake = Date.now(); wake(); }
  });
  // Tenta de novo de tempos em tempos (falha de rede sem o evento "offline", ex.: Wi-Fi sem internet).
  setInterval(() => { if (db && document.visibilityState === 'visible') wake(); }, 120000);

  return {
    open, close, wipe, hasData, rows, get, insert, update, remove, pull, flush,
    get pending() { return outbox.length; },
    get online() { return online(); },
    get opened() { return opened; },
  };
}
