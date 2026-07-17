/* ============================================================
   Cadence service worker
   - Handles background push notifications via Firebase Cloud Messaging
   - Handles basic offline caching of the app shell
   IMPORTANT: firebaseConfig below must match the config in app.js.
   This file must be served from the SITE ROOT (public/), not a subfolder,
   or FCM cannot register it with default scope.
   ============================================================ */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');

// ---- REPLACE with the same config object used in app.js ----
firebase.initializeApp({
  apiKey : "AIzaSyAzmRA26ZM_h7ICSjrmzejjk2sFYIWpyPE" , 
  authDomain : "cadence-fad9c.firebaseapp.com" , 
  projectId : "cadence-fad9c" , 
  storageBucket : "cadence-fad9c.firebasestorage.app" , 
  messagingSenderId : "751914840809" , 
  appId : "1:751914840809:web:6f0827e76cc44962fdf678" , 
  measurementId : "G-5NNP868M9M" 
});

const messaging = firebase.messaging();

// Fires when a push arrives while the app is NOT in the foreground.
// Reads from payload.data (not payload.notification) — see functions/index.js for why.
messaging.onBackgroundMessage((payload) => {
  const title = (payload.data && payload.data.title) || 'Cadence';
  const body = (payload.data && payload.data.body) || 'You have tasks scheduled today.';
  const tag = (payload.data && payload.data.tag) || ('cadence-' + Date.now());
  const subtaskId = (payload.data && payload.data.subtaskId) || null;
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag,
    data: { url: (payload.data && payload.data.link) || '/', subtaskId },
    actions: subtaskId ? [{ action: 'complete', title: '✓ Mark complete' }] : []
  });
});

// Attempts to mark a task complete straight from the notification, without
// opening the app. Relies on Firebase Auth's persisted session being readable
// from this service worker (same-origin IndexedDB) — if for any reason there's
// no session available here (e.g. a browser that partitions storage from the
// SW), we fall back to opening the app so the user can tap the checkbox there.
function getPersistedUser() {
  return new Promise((resolve) => {
    const unsub = firebase.auth().onAuthStateChanged((user) => {
      unsub();
      resolve(user);
    });
    // Don't hang forever if auth never resolves.
    setTimeout(() => resolve(firebase.auth().currentUser), 4000);
  });
}

async function markTaskCompleteFromNotification(subtaskId) {
  if (!subtaskId) return false;
  try {
    const user = await getPersistedUser();
    if (!user) return false;
    await firebase.firestore().collection('subtasks').doc(subtaskId).update({
      completed: true,
      completedAt: new Date().toISOString().slice(0, 10)
    });
    return true;
  } catch (err) {
    console.error('Could not mark task complete from notification', err);
    return false;
  }
}

// Tapping the notification body focuses/opens the app; tapping the "Mark complete"
// action instead tries to complete the task right from the notification tray.
self.addEventListener('notificationclick', (event) => {
  const subtaskId = event.notification.data && event.notification.data.subtaskId;

  if (event.action === 'complete') {
    event.notification.close();
    event.waitUntil((async () => {
      const ok = await markTaskCompleteFromNotification(subtaskId);
      if (ok) return;
      // Couldn't complete it here (e.g. no readable session in this context) —
      // fall back to opening the app so the user can still check it off there.
      const url = (event.notification.data && event.notification.data.url) || '/';
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })());
    return;
  }

  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

/* ---------------- Minimal offline app-shell caching ---------------- */
// Bumped so browsers holding an old service worker detect this file as changed
// and actually re-check/re-install instead of silently keeping stale JS forever.
const CACHE_NAME = 'cadence-shell-v3';
const SHELL_FILES = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: always try to get the latest file from the server, and only
// fall back to the cached copy if the network request fails (i.e. offline).
// This is what actually prevents the "old code stuck in cache" problem going
// forward — a deploy takes effect on the very next load, cache or no cache.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});