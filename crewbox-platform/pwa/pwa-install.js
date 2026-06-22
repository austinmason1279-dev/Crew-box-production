// ============================================================
// CREWBOX — PWA INSTALL & NOTIFICATION MANAGER
// File: pwa/pwa-install.js
//
// Add this script to EVERY dashboard page:
//   <script src="/pwa/pwa-install.js" defer></script>
//
// Handles:
//   1. Service worker registration
//   2. "Add to Home Screen" prompt (iOS + Android)
//   3. Push notification permission + subscription
//   4. App update detection + user notification
//   5. KPI caching for offline display
//   6. Install analytics
// ============================================================

(function() {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────
  const SW_PATH      = '/pwa/sw.js';
  const VAPID_KEY    = window.CREWBOX_VAPID_PUBLIC_KEY || '';  // set in HTML
  const APP_URL      = window.CREWBOX_APP_URL || '';

  // ── STATE ────────────────────────────────────────────────
  let swRegistration     = null;
  let deferredPrompt     = null;  // Android "Add to Home Screen" event
  let pushSubscription   = null;

  // ── INIT (runs on every page load) ──────────────────────
  async function init() {
    if (!('serviceWorker' in navigator)) {
      console.log('[CrewBox PWA] Service workers not supported');
      return;
    }

    try {
      // Register service worker
      swRegistration = await navigator.serviceWorker.register(SW_PATH, {
        scope: '/',
        updateViaCache: 'none',  // always check for SW updates
      });

      console.log('[CrewBox PWA] Service worker registered');

      // Listen for updates
      swRegistration.addEventListener('updatefound', handleUpdateFound);

      // Check for waiting SW on load (app was updated while closed)
      if (swRegistration.waiting) {
        showUpdateBanner();
      }

      // Listen for SW messages
      navigator.serviceWorker.addEventListener('message', handleSWMessage);

      // iOS: detect standalone mode
      detectStandaloneMode();

      // Android: capture install prompt
      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

      // Track installs
      window.addEventListener('appinstalled', handleAppInstalled);

      // Set up push notifications (after 30 seconds — don't ask immediately)
      setTimeout(setupPushNotifications, 30000);

      // Cache current KPI data for offline use
      cacheKPIData();

    } catch (err) {
      console.error('[CrewBox PWA] SW registration failed:', err);
    }
  }

  // ── SERVICE WORKER UPDATE HANDLING ──────────────────────

  function handleUpdateFound() {
    const newWorker = swRegistration.installing;
    newWorker.addEventListener('statechange', () => {
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        // New version available — show update banner
        showUpdateBanner();
      }
    });
  }

  function showUpdateBanner() {
    // Don't show if already visible
    if (document.getElementById('crewbox-update-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'crewbox-update-banner';
    banner.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      background: #1E1E1E; border-top: 1px solid #2C2C2C;
      padding: 14px 20px; padding-bottom: calc(14px + env(safe-area-inset-bottom));
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      font-family: 'Inter', sans-serif;
      animation: slideUp .3s ease;
    `;

    banner.innerHTML = `
      <div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:800;
          text-transform:uppercase;letter-spacing:.3px;color:#fff;margin-bottom:2px">
          Update available
        </div>
        <div style="font-size:12px;color:#7A8A9A">A new version of CrewBox is ready.</div>
      </div>
      <button onclick="applyUpdate()" style="
        background:#F5C800;color:#111;border:none;border-radius:6px;
        padding:9px 18px;font-family:'Barlow Condensed',sans-serif;
        font-weight:900;font-size:14px;letter-spacing:.3px;text-transform:uppercase;
        cursor:pointer;white-space:nowrap;flex-shrink:0;
      ">Update Now</button>
    `;

    // Add slide-up animation
    const style = document.createElement('style');
    style.textContent = '@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}';
    document.head.appendChild(style);

    document.body.appendChild(banner);
  }

  window.applyUpdate = function() {
    if (swRegistration?.waiting) {
      swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    window.location.reload();
  };

  // ── ADD TO HOME SCREEN — ANDROID ────────────────────────

  function handleBeforeInstallPrompt(event) {
    event.preventDefault();
    deferredPrompt = event;

    // Check if already installed or dismissed recently
    if (isInstalled() || wasPromptDismissed()) return;

    // Show install prompt after 60 seconds of use
    const timeOnPage = sessionStorage.getItem('crewbox_session_start');
    const elapsed    = timeOnPage ? Date.now() - parseInt(timeOnPage) : 0;

    if (elapsed > 60000) {
      showInstallPrompt();
    } else {
      setTimeout(showInstallPrompt, Math.max(0, 60000 - elapsed));
    }
  }

  function showInstallPrompt() {
    if (!deferredPrompt || document.getElementById('crewbox-install-prompt')) return;

    const prompt = document.createElement('div');
    prompt.id = 'crewbox-install-prompt';
    prompt.style.cssText = `
      position: fixed; bottom: 80px; left: 16px; right: 16px; z-index: 9998;
      background: #1A1A1A; border: 1px solid #2C2C2C; border-radius: 14px;
      padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.6);
      font-family: 'Inter', sans-serif;
      animation: slideUp .35s cubic-bezier(.34,1.56,.64,1);
    `;

    prompt.innerHTML = `
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px">
        <div style="width:48px;height:48px;border-radius:12px;background:#111;
          border:1px solid #2C2C2C;display:flex;align-items:center;
          justify-content:center;font-size:24px;flex-shrink:0">🔧</div>
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:18px;
            font-weight:900;text-transform:uppercase;letter-spacing:.3px;
            color:#fff;margin-bottom:3px">Add CrewBox to your home screen</div>
          <div style="font-size:13px;color:#7A8A9A;line-height:1.5">
            Open your dashboard instantly. Works like a native app.
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="triggerInstall()" style="
          flex:1;background:#F5C800;color:#111;border:none;border-radius:7px;
          padding:12px;font-family:'Barlow Condensed',sans-serif;font-weight:900;
          font-size:15px;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;
        ">Add to Home Screen</button>
        <button onclick="dismissInstallPrompt()" style="
          background:transparent;color:#7A8A9A;border:1px solid #2C2C2C;
          border-radius:7px;padding:12px 16px;font-size:13px;cursor:pointer;
        ">Not now</button>
      </div>
    `;

    document.body.appendChild(prompt);
  }

  window.triggerInstall = async function() {
    if (!deferredPrompt) return;

    dismissInstallPrompt();
    deferredPrompt.prompt();

    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;

    if (outcome === 'accepted') {
      console.log('[CrewBox PWA] Install accepted');
      trackEvent('pwa_install_accepted');
    } else {
      console.log('[CrewBox PWA] Install dismissed');
      localStorage.setItem('crewbox_install_dismissed', Date.now().toString());
    }
  };

  window.dismissInstallPrompt = function() {
    const el = document.getElementById('crewbox-install-prompt');
    if (el) el.remove();
    localStorage.setItem('crewbox_install_dismissed', Date.now().toString());
  };

  // ── ADD TO HOME SCREEN — IOS ─────────────────────────────

  function detectStandaloneMode() {
    const isStandalone = window.navigator.standalone ||
      window.matchMedia('(display-mode: standalone)').matches;

    if (isStandalone) {
      document.documentElement.classList.add('pwa-standalone');
      sessionStorage.setItem('crewbox_is_pwa', 'true');
      return;
    }

    // Show iOS install instructions if on Safari and not installed
    const isIOS     = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isSafari  = /safari/i.test(navigator.userAgent) && !/chrome|crios/i.test(navigator.userAgent);

    if (isIOS && isSafari && !wasPromptDismissed()) {
      setTimeout(showIOSInstructions, 8000);
    }
  }

  function showIOSInstructions() {
    if (document.getElementById('crewbox-ios-prompt')) return;

    const prompt = document.createElement('div');
    prompt.id = 'crewbox-ios-prompt';
    prompt.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9998;
      background: #1A1A1A; border-top: 1px solid #2C2C2C;
      padding: 20px 20px calc(20px + env(safe-area-inset-bottom));
      font-family: 'Inter', sans-serif;
      animation: slideUp .35s ease;
    `;

    prompt.innerHTML = `
      <!-- Arrow pointing to Safari share button -->
      <div style="position:absolute;bottom:calc(100% + 0px);left:50%;transform:translateX(-50%);
        width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;
        border-top:10px solid #1A1A1A;bottom:auto;top:100%;"></div>

      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:18px;
            font-weight:900;text-transform:uppercase;letter-spacing:.3px;
            color:#fff;margin-bottom:3px">Add to your home screen</div>
          <div style="font-size:13px;color:#7A8A9A">Opens like an app, no browser needed.</div>
        </div>
        <button onclick="dismissIOSPrompt()" style="
          background:transparent;border:none;color:#7A8A9A;
          font-size:20px;cursor:pointer;padding:4px;line-height:1;
        ">×</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:12px;
          background:#111;border-radius:8px;padding:12px 14px">
          <div style="font-size:22px;flex-shrink:0">1️⃣</div>
          <div style="font-size:13px;color:#C8C2BB;line-height:1.5">
            Tap the <strong style="color:#fff">Share button</strong>
            <span style="font-size:16px"> </span> at the bottom of Safari
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;
          background:#111;border-radius:8px;padding:12px 14px">
          <div style="font-size:22px;flex-shrink:0">2️⃣</div>
          <div style="font-size:13px;color:#C8C2BB;line-height:1.5">
            Scroll down and tap <strong style="color:#fff">"Add to Home Screen"</strong>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;
          background:#111;border-radius:8px;padding:12px 14px">
          <div style="font-size:22px;flex-shrink:0">3️⃣</div>
          <div style="font-size:13px;color:#C8C2BB;line-height:1.5">
            Tap <strong style="color:#F5C800">"Add"</strong> — CrewBox icon appears on your home screen
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(prompt);
  }

  window.dismissIOSPrompt = function() {
    const el = document.getElementById('crewbox-ios-prompt');
    if (el) el.remove();
    localStorage.setItem('crewbox_install_dismissed', Date.now().toString());
  };

  // ── PUSH NOTIFICATIONS ────────────────────────────────────

  async function setupPushNotifications() {
    if (!('Notification' in window) || !('PushManager' in window)) return;
    if (!swRegistration) return;

    // Don't ask if already granted or denied
    if (Notification.permission === 'granted') {
      await subscribeToPush();
      return;
    }
    if (Notification.permission === 'denied') return;

    // Only ask if user seems engaged (visited 3+ times)
    const visitCount = parseInt(localStorage.getItem('crewbox_visits') || '0');
    if (visitCount < 3) return;

    // Show custom permission prompt (better UX than native browser prompt)
    showNotificationPrompt();
  }

  function showNotificationPrompt() {
    if (document.getElementById('crewbox-notif-prompt')) return;

    const prompt = document.createElement('div');
    prompt.id = 'crewbox-notif-prompt';
    prompt.style.cssText = `
      position: fixed; top: 80px; right: 16px; z-index: 9997;
      background: #1A1A1A; border: 1px solid #2C2C2C; border-radius: 12px;
      padding: 16px; max-width: 300px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
      font-family: 'Inter', sans-serif;
      animation: fadeIn .3s ease;
    `;

    prompt.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px">
        <div style="font-size:24px;flex-shrink:0">🔔</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:3px">
            Get notified instantly
          </div>
          <div style="font-size:12px;color:#7A8A9A;line-height:1.5">
            When the AI books a job or a customer pays an invoice — you'll know immediately.
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="enableNotifications()" style="
          flex:1;background:#F5C800;color:#111;border:none;border-radius:6px;
          padding:9px;font-family:'Barlow Condensed',sans-serif;font-weight:900;
          font-size:13px;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;
        ">Turn On</button>
        <button onclick="dismissNotifPrompt()" style="
          background:transparent;color:#7A8A9A;border:1px solid #2C2C2C;
          border-radius:6px;padding:9px 12px;font-size:12px;cursor:pointer;
        ">Later</button>
      </div>
    `;

    document.body.appendChild(prompt);
  }

  window.enableNotifications = async function() {
    window.dismissNotifPrompt();

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await subscribeToPush();
      showToastIfAvailable('Notifications enabled — you\'ll hear about every call and payment 🔔');
    }
  };

  window.dismissNotifPrompt = function() {
    const el = document.getElementById('crewbox-notif-prompt');
    if (el) el.remove();
  };

  async function subscribeToPush() {
    if (!VAPID_KEY || !swRegistration) return;

    try {
      pushSubscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
      });

      // Send subscription to backend
      const token = localStorage.getItem('crewbox_access_token');
      await fetch('/api/push/subscribe', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          subscription: pushSubscription.toJSON(),
          userAgent:    navigator.userAgent,
        }),
      });

      console.log('[CrewBox PWA] Push subscription active');
      localStorage.setItem('crewbox_push_subscribed', 'true');

    } catch (err) {
      console.error('[CrewBox PWA] Push subscription failed:', err);
    }
  }

  // ── KPI CACHING (for offline display) ───────────────────

  function cacheKPIData() {
    // Read current KPIs from the DOM if dashboard is loaded
    const kpis = {};

    const revenue     = document.getElementById('kpi-revenue')?.textContent;
    const calls       = document.getElementById('kpi-calls')?.textContent;
    const outstanding = document.getElementById('kpi-outstanding')?.textContent;
    const rating      = document.getElementById('kpi-rating')?.textContent;

    if (revenue) kpis.revenue     = revenue;
    if (calls)   kpis.callsMonth  = calls;
    if (outstanding) kpis.outstanding = outstanding;
    if (rating)  kpis.avgRating   = rating;

    if (Object.keys(kpis).length > 0) {
      localStorage.setItem('crewbox_cached_kpis', JSON.stringify(kpis));
      localStorage.setItem('crewbox_last_sync', new Date().toISOString());
    }

    // Cache again every 5 minutes while dashboard is open
    setTimeout(cacheKPIData, 5 * 60 * 1000);
  }

  // ── SW MESSAGE HANDLER ────────────────────────────────────
  function handleSWMessage(event) {
    const { type, url } = event.data || {};

    if (type === 'NAVIGATE' && url) {
      window.location.href = url;
    }

    if (type === 'SYNC_COMPLETE') {
      showToastIfAvailable('Synced ✓ — your data is up to date');
    }
  }

  // ── INSTALL TRACKING ──────────────────────────────────────
  function handleAppInstalled() {
    console.log('[CrewBox PWA] App installed!');
    localStorage.setItem('crewbox_installed', 'true');
    trackEvent('pwa_installed');

    // Remove any install prompts
    document.getElementById('crewbox-install-prompt')?.remove();
    document.getElementById('crewbox-ios-prompt')?.remove();
  }

  // ── SESSION TRACKING ──────────────────────────────────────
  function trackSession() {
    // Track visit count for notification prompt timing
    const visits = parseInt(localStorage.getItem('crewbox_visits') || '0');
    localStorage.setItem('crewbox_visits', (visits + 1).toString());

    // Track session start time for install prompt timing
    if (!sessionStorage.getItem('crewbox_session_start')) {
      sessionStorage.setItem('crewbox_session_start', Date.now().toString());
    }
  }

  // ── HELPERS ───────────────────────────────────────────────
  function isInstalled() {
    return localStorage.getItem('crewbox_installed') === 'true' ||
      window.navigator.standalone ||
      window.matchMedia('(display-mode: standalone)').matches;
  }

  function wasPromptDismissed() {
    const dismissed = localStorage.getItem('crewbox_install_dismissed');
    if (!dismissed) return false;
    // Re-show after 7 days
    return Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  }

  function showToastIfAvailable(msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
    }
  }

  function trackEvent(name, data = {}) {
    // Send to analytics (swap with your analytics tool)
    console.log('[CrewBox Analytics]', name, data);
    // fetch('/api/analytics/event', { method: 'POST', body: JSON.stringify({ name, data }) });
  }

  // ── START ─────────────────────────────────────────────────
  trackSession();

  // Register SW after page is fully loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
