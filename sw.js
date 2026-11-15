// Back Rehab offline support. Bump VERSION when you upload a new build.
const VERSION = 'back-rehab-v56';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon.png', './fig3.js', './three.module.min.js', './body.json', './body.bin', './tex/defaultMat_0_c.jpg', './tex/defaultMat_0_n.jpg', './tex/defaultMat_10_c.jpg', './tex/defaultMat_10_n.jpg', './tex/defaultMat_11_c.jpg', './tex/defaultMat_11_n.jpg', './tex/defaultMat_12_c.jpg', './tex/defaultMat_12_n.jpg', './tex/defaultMat_1_c.jpg', './tex/defaultMat_1_n.jpg', './tex/defaultMat_2_c.jpg', './tex/defaultMat_2_n.jpg', './tex/defaultMat_3_c.jpg', './tex/defaultMat_3_n.jpg', './tex/defaultMat_4_c.jpg', './tex/defaultMat_4_n.jpg', './tex/defaultMat_5_c.jpg', './tex/defaultMat_5_n.jpg', './tex/defaultMat_6_c.jpg', './tex/defaultMat_6_n.jpg', './tex/defaultMat_7_c.jpg', './tex/defaultMat_7_n.jpg', './tex/defaultMat_8_c.jpg', './tex/defaultMat_8_n.jpg', './tex/defaultMat_9_c.jpg', './tex/defaultMat_9_n.jpg', './tex/defaultMat_c.jpg', './tex/defaultMat_n.jpg', './titan/body.json', './titan/body.bin', './titan/tex/base.jpg', './titan/tex/normal.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Network first for the page so updates show up; fall back to cache offline.
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })));
});
