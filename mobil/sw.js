// Çevrimdışı çalışma: uygulama dosyalarını önbellekte tutar (öğrenci verisi önbelleğe GİRMEZ;
// o yalnızca localStorage'dadır). Ağ isteği yalnızca uygulama dosyalarının güncellenmesi içindir.
const CACHE = 'yna-mobil-v13'; // dosyalar değişince artırın
const ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'kagit.js',
  'kagit-cv.js',
  'lib/digit-net.json',
  'manifest.webmanifest',
  '../ui/qr-ui.js',
  '../ui/qr-ui.css',
  '../modules/qr-transfer.js',
  '../modules/paper-template.js',
  '../modules/digit-net.js',
  '../modules/score-reconcile.js',
  '../modules/score-validator.js',
  '../modules/score-calculator.js',
  '../modules/export-manager.js',
  '../vendor/qrcode-generator.js',
  '../vendor/jsQR.js',
  '../assets/icons/icon192.png',
  '../assets/icons/icon512.png',
  '../assets/icons/icon512-maskable.png',
  '../assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' → tarayıcının HTTP önbelleğindeki eski kopyayı değil, sunucudaki güncel dosyayı al
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Önce önbellek, arkada güncelle (stale-while-revalidate)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req, { cache: 'no-cache' }) // arka plan güncellemesi sunucuya sorar
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        e.waitUntil(net);
        return hit;
      }
      return (await net) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    })
  );
});
