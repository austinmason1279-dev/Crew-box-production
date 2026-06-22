// ============================================================
// CREWBOX — SERVICE WORKER
// File: pwa/sw.js
//
// Handles:
//   1. Smart caching (app shell + API responses)
//   2. Offline fallback
//   3. Background sync (queue actions when offline)
//   4. Push notifications (new calls, invoice paid, etc.)
//   5. Periodic background sync (refresh data while app closed)
//
// Cache Strategy:
//   App shell (HTML/CSS/JS) → Cache First
//   API data (calls, invoices) → Network First + cache fallback
//   Images/fonts → Stale While Revalidate
//   Payment pages → Network Only (never cache financial UI)
// ============================================================

const APP_VERSION   = 'crewbox-v1.0.0';
const SHELL_CACHE   = `${APP_VERSION}-shell`;
const DATA_CACHE    = `${APP_VERSION}-data`;
const IMAGE_CACHE   = `${APP_VERSION}-images`;

// ── FILES TO CACHE ON INSTALL (app shell) ─────────────────
const SHELL_FILES = [
  '/',
  '/my-business',
  '/partner',
  '/auth',
  '/setup',
  '/offline',
  '/manifest.json',
  '/frontend/dashboard.html',
  '/frontend/licensee-portal.html',
  '/frontend/auth.html',
  '/frontend/setup-wizard.html',
  '/frontend/api/supabase-client.js',
  '/frontend/api/crewbox-api.js',
  '/frontend/api/dashboard-loader.js',
  '/pwa/icons/icon-192.png',
  '/pwa/icons/icon-512.png',
];

// ── API ROUTES TO CACHE (with network-first strategy) ─────
const DATA_ROUTES = [
  '/api/contractors/',
  '/api/licensees/',
  '/health',
];

// ── NEVER CACHE THESE (security-sensitive) ────────────────
const NO_CACHE_ROUTES = [
  '/pay/',          // payment pages — always fresh
  '/quote/',        // quote acceptance — always fresh
  '/api/webhooks/', // webhooks — always fresh
  '/auth/callback', // OAuth callbacks
];

// ============================================================
// INSTALL — cache app shell
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[CrewBox SW] Installing version:', APP_VERSION);

  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        console.log('[CrewBox SW] Caching app shell');
        return cache.addAll(SHELL_FILES);
      })
      .then(() => self.skipWaiting()) // activate immediately
      .catch(err => console.error('[CrewBox SW] Shell cache failed:', err))
  );
});

// ============================================================
// ACTIVATE — clean up old caches
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[CrewBox SW] Activating:', APP_VERSION);

  event.waitUntil(
    Promise.all([
      // Delete old cache versions
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(key => key !== SHELL_CACHE && key !== DATA_CACHE && key !== IMAGE_CACHE)
            .map(key => {
              console.log('[CrewBox SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      ),
      // Take control of all clients immediately
      self.clients.claim(),
    ])
  );
});

// ============================================================
// FETCH — intercept all network requests
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests (POST for actions goes through normally)
  if (request.method !== 'GET') return;

  // Skip cross-origin requests (Supabase, Stripe, Vapi APIs)
  if (url.origin !== self.location.origin) return;

  // Never cache payment/security routes
  if (NO_CACHE_ROUTES.some(route => url.pathname.includes(route))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // App shell → Cache First
  if (SHELL_FILES.some(file => url.pathname === file || url.pathname.startsWith(file))) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // API data → Network First with cache fallback
  if (DATA_ROUTES.some(route => url.pathname.startsWith(route))) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Images → Stale While Revalidate
  if (request.destination === 'image') {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  // Everything else → Network First
  event.respondWith(networkFirst(request, DATA_CACHE));
});

// ── CACHING STRATEGIES ────────────────────────────────────

/**
 * Cache First: Return cached version immediately.
 * Only fetch from network if not in cache.
 * Best for: App shell (HTML, CSS, JS that rarely changes)
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Network First: Always try network, fall back to cache.
 * Best for: API data (calls, invoices — needs to be fresh)
 */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

/**
 * Stale While Revalidate: Return cache immediately,
 * update cache in background.
 * Best for: Images, fonts (acceptable to be slightly stale)
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });

  return cached || fetchPromise;
}

/**
 * Network Only: Never cache.
 * Best for: Payment pages, webhooks, sensitive routes
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Offline Fallback: Show offline page or JSON error
 */
async function offlineFallback(request) {
  const url = new URL(request.url);

  // API requests get a JSON offline response
  if (url.pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No internet connection. Data will sync when you reconnect.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Navigation requests get the offline page
  const offlinePage = await caches.match('/offline');
  return offlinePage || new Response('<h1>No internet connection</h1>', {
    status: 503,
    headers: { 'Content-Type': 'text/html' },
  });
}

// ============================================================
// BACKGROUND SYNC — queue actions when offline
// ============================================================

// Queue names
const SYNC_TAGS = {
  NEW_JOB:     'sync-new-job',
  NEW_INVOICE: 'sync-new-invoice',
  NEW_QUOTE:   'sync-new-quote',
};

self.addEventListener('sync', (event) => {
  console.log('[CrewBox SW] Background sync:', event.tag);

  if (event.tag === SYNC_TAGS.NEW_JOB) {
    event.waitUntil(syncQueuedJobs());
  }
  if (event.tag === SYNC_TAGS.NEW_INVOICE) {
    event.waitUntil(syncQueuedInvoices());
  }
  if (event.tag === SYNC_TAGS.NEW_QUOTE) {
    event.waitUntil(syncQueuedQuotes());
  }
});

async function syncQueuedJobs() {
  const queue = await getQueue('offline-jobs');
  for (const job of queue) {
    try {
      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
      });
      await removeFromQueue('offline-jobs', job.id);
      await notifyClients({ type: 'SYNC_COMPLETE', entity: 'job', data: job });
    } catch (err) {
      console.error('[CrewBox SW] Job sync failed:', err);
    }
  }
}

async function syncQueuedInvoices() {
  const queue = await getQueue('offline-invoices');
  for (const invoice of queue) {
    try {
      await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invoice),
      });
      await removeFromQueue('offline-invoices', invoice.id);
    } catch (err) {
      console.error('[CrewBox SW] Invoice sync failed:', err);
    }
  }
}

async function syncQueuedQuotes() {
  // Same pattern as jobs/invoices
  const queue = await getQueue('offline-quotes');
  for (const quote of queue) {
    try {
      await fetch('/api/quotes/generate', {
        method: 'POST',
        body: JSON.stringify(quote),
      });
      await removeFromQueue('offline-quotes', quote.id);
    } catch (err) {
      console.error('[CrewBox SW] Quote sync failed:', err);
    }
  }
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'CrewBox', body: event.data.text() };
  }

  console.log('[CrewBox SW] Push received:', data);

  const options = buildNotificationOptions(data);

  event.waitUntil(
    self.registration.showNotification(data.title || 'CrewBox', options)
  );
});

function buildNotificationOptions(data) {
  // Different styles per notification type
  const typeConfig = {
    new_call: {
      icon:  '/pwa/icons/icon-192.png',
      badge: '/pwa/icons/badge-72.png',
      tag:   'new-call',
      vibrate: [200, 100, 200],
    },
    call_booked: {
      icon:  '/pwa/icons/icon-192.png',
      badge: '/pwa/icons/badge-72.png',
      tag:   'call-booked',
      vibrate: [100, 50, 100],
    },
    invoice_paid: {
      icon:  '/pwa/icons/icon-192.png',
      badge: '/pwa/icons/badge-72.png',
      tag:   'invoice-paid',
      vibrate: [300, 100, 300, 100, 300],
    },
    review_alert: {
      icon:  '/pwa/icons/icon-192.png',
      badge: '/pwa/icons/badge-72.png',
      tag:   'review-alert',
      vibrate: [200],
    },
    doc_expiry: {
      icon:  '/pwa/icons/icon-192.png',
      badge: '/pwa/icons/badge-72.png',
      tag:   'doc-expiry',
      vibrate: [100],
    },
  };

  const config = typeConfig[data.type] || typeConfig.new_call;

  return {
    body:    data.body || data.message || '',
    icon:    config.icon,
    badge:   config.badge,
    tag:     config.tag,
    vibrate: config.vibrate,
    silent:  false,
    requireInteraction: data.type === 'new_call', // keep call notifications visible
    data: {
      url:  data.url  || '/my-business',
      type: data.type || 'general',
      id:   data.id   || null,
    },
    actions: buildNotificationActions(data.type),
  };
}

function buildNotificationActions(type) {
  const actionSets = {
    new_call: [
      { action: 'view', title: 'View Call' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    call_booked: [
      { action: 'view', title: 'View Booking' },
      { action: 'dismiss', title: 'OK' },
    ],
    invoice_paid: [
      { action: 'view', title: 'View Receipt' },
      { action: 'dismiss', title: 'Got it' },
    ],
    review_alert: [
      { action: 'respond', title: 'Approve Response' },
      { action: 'view', title: 'View Review' },
    ],
    doc_expiry: [
      { action: 'upload', title: 'Upload Now' },
      { action: 'dismiss', title: 'Remind me later' },
    ],
  };
  return actionSets[type] || [{ action: 'view', title: 'Open' }];
}

// ── NOTIFICATION CLICK HANDLER ────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  const data   = event.notification.data;

  let targetUrl = data.url || '/my-business';

  // Route based on action clicked
  if (action === 'respond' && data.type === 'review_alert') {
    targetUrl = `/my-business?tab=reviews&review=${data.id}&action=approve`;
  } else if (action === 'upload' && data.type === 'doc_expiry') {
    targetUrl = `/my-business?tab=documents&action=upload`;
  } else if (action === 'view') {
    targetUrl = data.url || '/my-business';
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus existing window if open
        const existing = clients.find(c => c.url.includes(self.location.origin));
        if (existing) {
          existing.focus();
          existing.postMessage({ type: 'NAVIGATE', url: targetUrl });
          return;
        }
        // Open new window
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ── NOTIFICATION CLOSE HANDLER ────────────────────────────
self.addEventListener('notificationclose', (event) => {
  // Track dismissed notifications for analytics
  const data = event.notification.data;
  console.log('[CrewBox SW] Notification dismissed:', data?.type);
});

// ============================================================
// PERIODIC BACKGROUND SYNC
// Refreshes data while app is closed (Android only for now)
// ============================================================

self.addEventListener('periodicsync', (event) => {
  console.log('[CrewBox SW] Periodic sync:', event.tag);

  if (event.tag === 'refresh-dashboard') {
    event.waitUntil(refreshDashboardData());
  }
});

async function refreshDashboardData() {
  // Pre-fetch key API endpoints to warm the cache
  // So when user opens the app, data loads instantly
  const session = await getStoredSession();
  if (!session) return;

  const endpoints = [
    '/api/contractors/' + session.contractorId + '/dashboard',
    '/api/calls/recent',
  ];

  const cache = await caches.open(DATA_CACHE);
  await Promise.allSettled(
    endpoints.map(url =>
      fetch(url, { headers: { Authorization: `Bearer ${session.token}` } })
        .then(res => res.ok ? cache.put(url, res) : null)
        .catch(() => null)
    )
  );
}

// ============================================================
// MESSAGE HANDLER (from app → service worker)
// ============================================================

self.addEventListener('message', (event) => {
  const { type, data } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CACHE_URLS':
      // App can ask SW to cache specific URLs
      if (data?.urls) {
        caches.open(DATA_CACHE).then(cache => cache.addAll(data.urls));
      }
      break;

    case 'CLEAR_CACHE':
      // Used on logout — clear user data from cache
      Promise.all([
        caches.delete(DATA_CACHE),
        caches.delete(IMAGE_CACHE),
      ]).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case 'QUEUE_OFFLINE_ACTION':
      // Queue an action to sync when back online
      addToQueue(data.queue, data.item)
        .then(() => event.ports[0]?.postMessage({ queued: true }));
      break;
  }
});

// ============================================================
// QUEUE HELPERS (uses Cache API as simple key-value store)
// ============================================================

async function getQueue(name) {
  const cache  = await caches.open('crewbox-queues');
  const stored = await cache.match(`/queue/${name}`);
  if (!stored) return [];
  return stored.json();
}

async function addToQueue(name, item) {
  const queue = await getQueue(name);
  queue.push({ ...item, queued_at: Date.now() });
  const cache = await caches.open('crewbox-queues');
  await cache.put(`/queue/${name}`, new Response(JSON.stringify(queue)));
}

async function removeFromQueue(name, id) {
  const queue   = await getQueue(name);
  const updated = queue.filter(item => item.id !== id);
  const cache   = await caches.open('crewbox-queues');
  await cache.put(`/queue/${name}`, new Response(JSON.stringify(updated)));
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}

async function getStoredSession() {
  try {
    const cache = await caches.open('crewbox-session');
    const stored = await cache.match('/session');
    if (!stored) return null;
    return stored.json();
  } catch {
    return null;
  }
}

console.log('[CrewBox SW] Service worker loaded:', APP_VERSION);
