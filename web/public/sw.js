self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Navigations go to the network without the worker: Chrome sends a navigation a worker re-fetches with
// Sec-Fetch-Dest: empty, and the daemon lets a cross-site navigation (an Android intent: kiosk, hotkey, open-url)
// through only as a document. Everything else is fetched as before.
self.addEventListener('fetch', (e) => { if (e.request.mode !== 'navigate') e.respondWith(fetch(e.request)); });
