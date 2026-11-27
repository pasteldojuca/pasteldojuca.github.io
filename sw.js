// Service worker: sempre busca a versão mais nova; usa o cache só sem internet.
const CACHE = "pjuca-v29";
const ARQUIVOS = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./og.jpg",
  "./fonts/anton-latin-400-normal.woff2", "./fonts/barlow-latin-400-normal.woff2", "./fonts/barlow-latin-500-normal.woff2", "./fonts/barlow-latin-600-normal.woff2", "./fonts/barlow-latin-700-normal.woff2", "./fonts/barlow-condensed-latin-500-normal.woff2", "./fonts/barlow-condensed-latin-600-normal.woff2", "./fonts/barlow-condensed-latin-700-normal.woff2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/e/") || u.pathname.startsWith("/api/")) return; // links do entregador: sempre direto ao servidor
  e.respondWith(
    fetch(req).then(res => { if (res.ok && !res.redirected) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return res; })
      .catch(() => caches.match(req).then(r => r || caches.match("./")))
  );
});
