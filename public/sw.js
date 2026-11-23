// Tome Nota! — service worker: o app abre sem internet.
// - Páginas: rede primeiro (pega a versão nova), com a cópia guardada como reserva offline.
// - Arquivos com hash (/assets/…): cópia primeiro (nunca mudam).
// - Ícones, manifest: cópia na hora e atualiza em segundo plano.
// - Supabase e outros sites: nunca passam por aqui (os dados offline ficam no IndexedDB do app).
const CACHE = 'tomenota-v1';
const SCOPE = new URL(self.registration.scope);
const INDEX = new URL('./', SCOPE).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(INDEX)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// O app avisa quais arquivos usou na primeira visita (antes de o service worker existir).
self.addEventListener('message', (e) => {
  if (e.data?.type === 'cache') e.waitUntil(caches.open(CACHE).then((c) => Promise.all(
    e.data.urls.filter((u) => new URL(u).origin === location.origin).map((u) => c.add(u).catch(() => {})),
  )));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.href.startsWith(SCOPE.href)) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(INDEX, res.clone());
        return res;
      } catch {
        return (await c.match(INDEX)) || new Response('Sem conexão.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (url.pathname.includes('/assets/')) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })());
});
