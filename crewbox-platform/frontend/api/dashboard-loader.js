// ============================================================
// CREWBOX — DASHBOARD LOADER
// File: frontend/api/dashboard-loader.js
//
// Bridges the HTML dashboards to real Supabase data.
// Handles: initial load, loading states, empty states,
// error handling, real-time updates, and refresh logic.
//
// Usage (add to bottom of each dashboard HTML file):
//
//   <!-- Contractor dashboard -->
//   <script type="module">
//     import { initContractorDashboard } from './api/dashboard-loader.js';
//     initContractorDashboard();
//   </script>
//
//   <!-- Licensee portal -->
//   <script type="module">
//     import { initLicenseeDashboard } from './api/dashboard-loader.js';
//     initLicenseeDashboard();
//   </script>
// ============================================================

import { requireAuth, signOut } from './supabase-client.js';
import {
  getContractorProfile,
  getContractorKPIs,
  getRecentCalls,
  getCallAnalytics,
  getRecentJobs,
  getOpenInvoices,
  getFinancialSummary,
  getAgentStatuses,
  getContractorActivity,
  getReviews,
  getReputationStats,
  getDocuments,
  subscribeToActivity,
  subscribeToNewCalls,
  subscribeToInvoices,
  sendManualReminder,
  approveReviewResponse,
  toggleAgent,
} from './crewbox-api.js';

import {
  getLicenseeProfile,
  getLicenseeClients,
  getLicenseeKPIs,
  getLicenseeActivity,
  subscribeToLicenseeActivity,
} from './crewbox-api.js';

// ============================================================
// ── UI UTILITIES ──────────────────────────────────────────
// ============================================================

// Loading skeleton HTML
const SKELETON = (lines = 3) => Array.from({ length: lines }, (_, i) => `
  <div style="background:rgba(255,255,255,.05);border-radius:6px;height:${i === 0 ? '20px' : '14px'};
    width:${i === 0 ? '60%' : i === 1 ? '80%' : '50%'};
    margin-bottom:10px;
    background:linear-gradient(90deg,rgba(255,255,255,.04) 0%,rgba(255,255,255,.08) 50%,rgba(255,255,255,.04) 100%);
    background-size:200% 100%;animation:shimmer 1.5s infinite;">
  </div>`).join('');

// Empty state HTML
const EMPTY = (icon, title, sub, actionHtml = '') => `
  <div style="text-align:center;padding:40px 20px;color:#7A8A9A;">
    <div style="font-size:32px;margin-bottom:12px">${icon}</div>
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:800;
      text-transform:uppercase;letter-spacing:.3px;color:#fff;margin-bottom:6px">${title}</div>
    <div style="font-size:13px;line-height:1.6;max-width:260px;margin:0 auto 16px">${sub}</div>
    ${actionHtml}
  </div>`;

// Error state HTML
const ERROR_STATE = (msg) => `
  <div style="text-align:center;padding:32px;background:rgba(239,68,68,.05);
    border:1px solid rgba(239,68,68,.15);border-radius:8px;margin:8px 0">
    <div style="font-size:20px;margin-bottom:8px">⚠️</div>
    <div style="font-size:13px;color:#FCA5A5;line-height:1.5">${msg}</div>
    <button onclick="location.reload()" style="margin-top:12px;background:transparent;
      color:#7A8A9A;border:1px solid #2C2C2C;border-radius:5px;padding:6px 14px;
      font-size:12px;cursor:pointer">Retry</button>
  </div>`;

// Toast notifications
function toast(msg, type = 'success') {
  const t = document.getElementById('toast') || createToast();
  t.textContent = msg;
  t.style.cssText = `
    display:block;position:fixed;bottom:24px;right:24px;z-index:999;
    padding:12px 20px;border-radius:8px;font-weight:600;font-size:13px;
    box-shadow:0 8px 32px rgba(0,0,0,.6);
    background:${type === 'success' ? '#22C55E' : type === 'error' ? '#EF4444' : '#F97316'};
    color:#fff;animation:slideIn .2s ease;`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.style.display = 'none', 3500);
}

function createToast() {
  const t = document.createElement('div');
  t.id = 'toast';
  document.body.appendChild(t);
  return t;
}

// Set inner HTML safely with shimmer style injected once
let shimmerInjected = false;
function setHTML(selector, html) {
  const el = document.querySelector(selector);
  if (!el) return;
  if (!shimmerInjected) {
    const style = document.createElement('style');
    style.textContent = '@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}';
    document.head.appendChild(style);
    shimmerInjected = true;
  }
  el.innerHTML = html;
}

function setText(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
}

function fmt$(n) { return '$' + (Number(n) || 0).toLocaleString(); }

// ============================================================
// ── CONTRACTOR DASHBOARD INIT ─────────────────────────────
// ============================================================

export async function initContractorDashboard() {
  // 1. Auth check — redirect to /auth if no session
  const user = await requireAuth(['contractor', 'platform_admin']);
  if (!user) return;

  const contractorId = user.contractorId;
  if (!contractorId) {
    // Logged in but no contractor profile yet — send to onboarding
    window.location.href = '/onboarding';
    return;
  }

  // 2. Show loading skeletons immediately
  showContractorSkeletons();

  // 3. Load all data in parallel
  try {
    const [profile, kpis, agents, calls, jobs, invoices, activity, reviews] = await Promise.all([
      getContractorProfile(contractorId),
      getContractorKPIs(contractorId),
      getAgentStatuses(contractorId),
      getRecentCalls(contractorId, 10),
      getRecentJobs(contractorId, 8),
      getOpenInvoices(contractorId),
      getContractorActivity(contractorId, 20),
      getReviews(contractorId, 10),
    ]);

    // 4. Render everything
    renderContractorHeader(profile, user);
    renderContractorKPIs(kpis);
    renderAgentCards(agents, contractorId);
    renderRecentCalls(calls);
    renderRecentJobs(jobs);
    renderOpenInvoices(invoices, contractorId);
    renderActivityFeed(activity, '#activity-feed');
    renderReviews(reviews, contractorId);

    // 5. Wire up sign-out
    document.querySelectorAll('[data-signout]').forEach(btn => {
      btn.addEventListener('click', signOut);
    });

    // 6. Start real-time subscriptions
    const unsubActivity = subscribeToActivity(contractorId, (event) => {
      prependActivity(event, '#activity-feed');
      // Also refresh KPIs if it's a financial event
      if (event.amount) refreshContractorKPIs(contractorId);
    });

    const unsubCalls = subscribeToNewCalls(contractorId, (call) => {
      prependCall(call, '#calls-feed');
      toast(`📞 New call: ${call.name} — ${call.outcome}`);
      refreshContractorKPIs(contractorId);
    });

    const unsubInvoices = subscribeToInvoices(contractorId, () => {
      getOpenInvoices(contractorId).then(inv => renderOpenInvoices(inv, contractorId));
      refreshContractorKPIs(contractorId);
    });

    // 7. Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      unsubActivity();
      unsubCalls();
      unsubInvoices();
    });

  } catch (err) {
    console.error('[CrewBox] Dashboard load error:', err);
    showContractorError(err.message);
  }
}

// ── KPI REFRESH (called after real-time events) ───────────
async function refreshContractorKPIs(contractorId) {
  try {
    const kpis = await getContractorKPIs(contractorId);
    renderContractorKPIs(kpis);
  } catch (e) { /* silent */ }
}

// ── RENDER FUNCTIONS ──────────────────────────────────────

function renderContractorHeader(profile, user) {
  setText('#dashboard-biz-name',  profile.business_name || user.name);
  setText('#dashboard-user-name', user.name.split(' ')[0]);
  setText('#dashboard-ai-phone',  profile.ai_phone_number || 'Not set up');
  setText('#dashboard-city',      `${profile.address_city}, ${profile.address_state}`);

  // Avatar
  const avatarEl = document.querySelector('#dashboard-avatar');
  if (avatarEl) avatarEl.textContent = profile.business_name[0].toUpperCase();

  // Phone setup status
  const phoneStatus = document.querySelector('#phone-setup-status');
  if (phoneStatus) {
    phoneStatus.textContent = profile.ai_phone_number
      ? `AI answers on ${profile.ai_phone_number}`
      : 'Phone not yet set up — click to configure';
    phoneStatus.style.color = profile.ai_phone_number ? '#22C55E' : '#F97316';
  }

  // Onboarding banner
  if (!profile.onboarding_complete) {
    showOnboardingBanner(profile.onboarding_step);
  }
}

function renderContractorKPIs(kpis) {
  setText('#kpi-revenue',      fmt$(kpis.revenueMonth));
  setText('#kpi-calls',        kpis.callsMonth.toLocaleString());
  setText('#kpi-outstanding',  fmt$(kpis.outstanding));
  setText('#kpi-rating',       kpis.avgRating ? `${kpis.avgRating}★` : '—');
  setText('#kpi-booking-rate', `${kpis.bookingRate}% booked`);
  setText('#kpi-overdue-count',kpis.overdueCount ? `${kpis.overdueCount} overdue` : 'All current');

  // Color outstanding red if > $0
  const outstandingEl = document.querySelector('#kpi-outstanding');
  if (outstandingEl) outstandingEl.style.color = kpis.outstanding > 0 ? '#EF4444' : '#22C55E';
}

function renderAgentCards(agents, contractorId) {
  const container = document.querySelector('#agent-cards');
  if (!container || !agents.length) return;

  container.innerHTML = agents.map(a => `
    <div class="agent-card" data-agent="${a.type}" onclick="openAgentModal('${a.type}')">
      <div class="live-corner" style="display:${a.isLive ? 'block' : 'none'}"></div>
      <div class="agent-icon">${a.icon}</div>
      <div class="agent-name">${a.name}</div>
      <div class="agent-metric">${getAgentMetric(a)}</div>
      <div style="display:flex;gap:6px;align-items:center">
        <span class="badge ${a.isLive ? 'badge-live' : 'badge-sl'}">${a.isLive ? 'LIVE' : 'PAUSED'}</span>
        <button onclick="event.stopPropagation();handleAgentToggle('${a.type}','${contractorId}',${!a.isLive})"
          style="font-size:10px;background:transparent;border:none;cursor:pointer;color:#7A8A9A;padding:2px">
          ${a.isLive ? '⏸' : '▶️'}
        </button>
      </div>
    </div>`).join('');

  // Make toggle available globally
  window.handleAgentToggle = async (type, cId, shouldActivate) => {
    try {
      await toggleAgent(cId, type, shouldActivate);
      const agents = await getAgentStatuses(cId);
      renderAgentCards(agents, cId);
      toast(`${type} agent ${shouldActivate ? 'activated' : 'paused'}`);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function getAgentMetric(agent) {
  // Will be replaced with real per-agent stats in future iteration
  const defaults = {
    receptionist: 'Answering all calls',
    estimator:    'Ready for job photos',
    collector:    'Monitoring invoices',
    marketer:     'Posts scheduled',
    rep:          'Reviews monitored',
  };
  return defaults[agent.type] || 'Active';
}

function renderRecentCalls(calls) {
  const container = document.querySelector('#calls-feed');
  if (!container) return;

  if (!calls.length) {
    container.innerHTML = EMPTY('📞', 'No calls yet', 'The Receptionist will answer your first call and it will appear here instantly.');
    return;
  }

  container.innerHTML = calls.map(c => `
    <div class="row-item">
      <div class="row-dot" style="background:${outcomeColor(c.outcome)}"></div>
      <div class="row-main">
        <div class="row-name">${escHtml(c.name)}${c.phone ? ` · ${c.phone}` : ''}</div>
        <div class="row-sub">${escHtml(c.summary || '—')}</div>
        <div class="row-time">${c.timeAgo}${c.durationDisplay !== '—' ? ` · ${c.durationDisplay}` : ''}</div>
      </div>
      <div class="row-right">
        <span class="badge ${outcomeBadgeClass(c.outcome)}">${c.outcome.toUpperCase()}</span>
      </div>
    </div>`).join('');
}

function renderRecentJobs(jobs) {
  const container = document.querySelector('#jobs-feed');
  if (!container) return;

  if (!jobs.length) {
    container.innerHTML = EMPTY('🔧', 'No jobs yet', 'Jobs created from AI-booked calls will appear here.');
    return;
  }

  container.innerHTML = jobs.map(j => `
    <div class="inv-row">
      <div style="flex:1">
        <div class="inv-name">${escHtml(j.title)}</div>
        <div style="font-size:11px;color:#7A8A9A">${escHtml(j.customer)} · ${j.dateDisplay}</div>
      </div>
      <div class="inv-amount" style="font-size:${j.amount ? '18px' : '14px'}">${j.amount ? fmt$(j.amount) : '—'}</div>
      <span class="badge ${statusBadge(j.status)}">${statusLabel(j.status)}</span>
    </div>`).join('');
}

function renderOpenInvoices(invoices, contractorId) {
  const container = document.querySelector('#invoices-feed');
  if (!container) return;

  if (!invoices.length) {
    container.innerHTML = EMPTY('💰', 'No open invoices', 'Invoices will appear here when created. The Collector agent will chase them automatically.');
    return;
  }

  container.innerHTML = invoices.map(i => `
    <div class="inv-row">
      <div style="flex:1">
        <div style="font-family:monospace;font-size:10px;color:#7A8A9A">${i.number}</div>
        <div class="inv-name">${escHtml(i.customer)}</div>
        ${i.daysOverdue > 0 ? `<div style="font-size:11px;color:#EF4444">${i.daysOverdue} days overdue · Reminder #${i.reminderCount}</div>` : `<div style="font-size:11px;color:#7A8A9A">Due ${formatDate(i.dueDate)}</div>`}
      </div>
      <div class="inv-amount" style="color:${i.isOverdue ? '#EF4444' : '#F5C800'}">${fmt$(i.amountDue)}</div>
      <span class="badge ${i.isOverdue ? 'badge-r' : 'badge-y'}">${i.isOverdue ? 'OVERDUE' : 'SENT'}</span>
      ${i.isOverdue ? `
        <button class="btn-remind"
          onclick="handleSendReminder('${i.id}','${escHtml(i.customer)}')">
          Remind
        </button>` : ''}
    </div>`).join('');

  // Make reminder handler globally available
  window.handleSendReminder = async (invoiceId, customerName) => {
    try {
      await sendManualReminder(invoiceId);
      toast(`Reminder sent to ${customerName} ✓`);
      const updated = await getOpenInvoices(contractorId);
      renderOpenInvoices(updated, contractorId);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function renderActivityFeed(activity, selector) {
  const container = document.querySelector(selector);
  if (!container) return;

  if (!activity.length) {
    container.innerHTML = EMPTY('📡', 'No activity yet', 'Agent actions will appear here in real time as they happen.');
    return;
  }

  container.innerHTML = activity.map(a => activityItemHTML(a)).join('');
}

function activityItemHTML(a) {
  return `
    <div class="feed-item" style="animation:slideIn .25s ease both">
      <div class="feed-dot" style="background:${a.agentColor}"></div>
      <div style="flex:1">
        <div class="feed-agent">${a.agentLabel}${a.businessName ? ` · ${a.businessName}` : ''}</div>
        <div class="feed-text">${escHtml(a.description)}</div>
        <div class="feed-time">${a.timeAgo}</div>
      </div>
      ${a.amountDisplay ? `<div class="feed-amount">${a.amountDisplay}</div>` : ''}
    </div>`;
}

function prependActivity(event, selector) {
  const container = document.querySelector(selector);
  if (!container) return;

  // Remove empty state if present
  if (container.querySelector('div[style*="text-align:center"]')) {
    container.innerHTML = '';
  }

  const el = document.createElement('div');
  el.innerHTML = activityItemHTML(event);
  container.insertBefore(el.firstElementChild, container.firstChild);

  // Keep max 20 items
  while (container.children.length > 20) container.removeChild(container.lastChild);
}

function prependCall(call, selector) {
  const container = document.querySelector(selector);
  if (!container) return;

  if (container.querySelector('div[style*="text-align:center"]')) container.innerHTML = '';

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="row-item" style="animation:slideIn .25s ease both">
      <div class="row-dot" style="background:${outcomeColor(call.outcome)}"></div>
      <div class="row-main">
        <div class="row-name">${escHtml(call.name)}</div>
        <div class="row-sub">${escHtml(call.summary || 'Call in progress...')}</div>
        <div class="row-time">${call.timeAgo}</div>
      </div>
      <div class="row-right">
        <span class="badge ${outcomeBadgeClass(call.outcome)}">${call.outcome.toUpperCase()}</span>
      </div>
    </div>`;
  container.insertBefore(el.firstElementChild, container.firstChild);
  while (container.children.length > 10) container.removeChild(container.lastChild);
}

function renderReviews(reviews, contractorId) {
  const container = document.querySelector('#reviews-feed');
  if (!container) return;

  if (!reviews.length) {
    container.innerHTML = EMPTY('⭐', 'No reviews synced yet', 'Connect your Google Business account to start managing reviews automatically.', '<button onclick="showToast(\'Opening Google connect flow...\')" style="background:#F5C800;color:#111;border:none;border-radius:5px;padding:7px 14px;font-size:12px;cursor:pointer;font-weight:700">Connect Google Business</button>');
    return;
  }

  container.innerHTML = reviews.map(r => `
    <div class="review-card ${r.needsApproval ? 'attention' : ''}">
      <div style="display:flex;justify-content:space-between;margin-bottom:5px">
        <span style="font-weight:600;font-size:13px">${escHtml(r.reviewer)}${r.needsApproval ? ' ⚠' : ''}</span>
        <span style="font-family:monospace;font-size:10px;color:#7A8A9A">${r.dateDisplay} · ${r.platform}</span>
      </div>
      <div style="color:${r.isNegative ? '#EF4444' : '#F5C800'};font-size:14px;margin-bottom:4px">${r.stars}</div>
      <div class="review-text">${escHtml(r.text)}</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge badge-b">${r.platform.toUpperCase()}</span>
        ${r.responded ? '<span class="badge badge-live">RESPONDED</span>' : ''}
        ${r.needsApproval ? `
          <button class="btn-respond" style="background:#EF4444;color:#fff"
            onclick="handleApproveResponse('${r.id}')">
            Review & Approve Response
          </button>` : ''}
        ${!r.responded && !r.needsApproval ? `
          <span class="badge badge-r">NEEDS RESPONSE</span>` : ''}
      </div>
    </div>`).join('');

  window.handleApproveResponse = async (reviewId) => {
    try {
      await approveReviewResponse(reviewId);
      toast('Response approved and posted ✓');
      const updated = await getReviews(contractorId, 10);
      renderReviews(updated, contractorId);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function showOnboardingBanner(step) {
  const banner = document.querySelector('#onboarding-banner');
  if (!banner) return;

  const steps = ['Business Info', 'Phone Setup', 'Agents Configured', 'Payments Connected', 'Documents Uploaded', 'Live'];
  const pct = Math.round(((step - 1) / 5) * 100);

  banner.style.display = 'block';
  banner.innerHTML = `
    <div style="background:rgba(249,115,22,.08);border:1px solid rgba(249,115,22,.2);
      border-radius:8px;padding:14px 18px;display:flex;align-items:center;gap:16px;margin-bottom:20px">
      <div style="font-size:20px">🔧</div>
      <div style="flex:1">
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:800;
          text-transform:uppercase;margin-bottom:6px">Complete your setup — Step ${step} of 6: ${steps[step - 1]}</div>
        <div style="background:rgba(0,0,0,.3);border-radius:3px;height:4px">
          <div style="background:#F97316;border-radius:3px;height:4px;width:${pct}%;transition:width .5s"></div>
        </div>
      </div>
      <a href="/onboarding" style="background:#F97316;color:#fff;font-family:'Barlow Condensed',sans-serif;
        font-weight:900;font-size:14px;letter-spacing:.3px;text-transform:uppercase;
        padding:8px 16px;border-radius:5px;text-decoration:none;">Continue →</a>
    </div>`;
}

function showContractorSkeletons() {
  const skeletonTargets = [
    '#calls-feed', '#jobs-feed', '#invoices-feed', '#activity-feed', '#reviews-feed'
  ];
  skeletonTargets.forEach(sel => setHTML(sel, SKELETON(4)));
}

function showContractorError(msg) {
  ['#calls-feed', '#jobs-feed', '#invoices-feed', '#activity-feed'].forEach(sel => {
    setHTML(sel, ERROR_STATE(msg));
  });
}

// ============================================================
// ── LICENSEE DASHBOARD INIT ───────────────────────────────
// ============================================================

export async function initLicenseeDashboard() {
  const user = await requireAuth(['licensee', 'platform_admin']);
  if (!user) return;

  const licenseeId = user.licenseeId;
  if (!licenseeId) {
    window.location.href = '/auth';
    return;
  }

  // Show skeletons
  showLicenseeSkeletons();

  try {
    const [profile, kpis, clients, activity] = await Promise.all([
      getLicenseeProfile(licenseeId),
      getLicenseeKPIs(licenseeId),
      getLicenseeClients(licenseeId),
      getLicenseeActivity(licenseeId, 30),
    ]);

    renderLicenseeHeader(profile, user);
    renderLicenseeKPIs(kpis);
    renderBookOfBusiness(clients);
    renderActivityFeed(activity, '#licensee-activity-feed');
    renderSidebarPlan(profile, kpis);

    // Sign-out
    document.querySelectorAll('[data-signout]').forEach(btn => btn.addEventListener('click', signOut));

    // Real-time: get contractor IDs for subscription
    const contractorIds = clients.map(c => c.id);
    const unsub = subscribeToLicenseeActivity(contractorIds, (event) => {
      prependActivity(event, '#licensee-activity-feed');
      // Refresh KPIs on financial events
      if (event.amount) getLicenseeKPIs(licenseeId).then(k => renderLicenseeKPIs(k));
    });

    window.addEventListener('beforeunload', unsub);

  } catch (err) {
    console.error('[CrewBox] Licensee dashboard error:', err);
    setHTML('#book-of-business', ERROR_STATE(err.message));
  }
}

function renderLicenseeHeader(profile, user) {
  setText('#licensee-brand-name', profile.brand_name || profile.company_name);
  setText('#licensee-user-name', user.name.split(' ')[0]);
  const avatar = document.querySelector('#licensee-avatar');
  if (avatar) avatar.textContent = (profile.brand_name || user.name)[0].toUpperCase();
}

function renderLicenseeKPIs(kpis) {
  setText('#lkpi-mrr',        fmt$(kpis.mrr));
  setText('#lkpi-clients',    kpis.activeClients.toLocaleString());
  setText('#lkpi-calls',      kpis.callsMonth.toLocaleString());
  setText('#lkpi-recovered',  fmt$(kpis.revenueRecovered));
  setText('#lkpi-net',        fmt$(kpis.netProfit));
  setText('#lkpi-margin',     kpis.mrr > 0 ? `${Math.round((kpis.netProfit / kpis.mrr) * 100)}% margin` : '—');
}

function renderSidebarPlan(profile, kpis) {
  const bar = document.querySelector('#plan-capacity-bar');
  const count = document.querySelector('#plan-capacity-count');
  if (bar) bar.style.width = `${Math.min(100, (kpis.activeClients / kpis.maxClients) * 100)}%`;
  if (count) count.textContent = `${kpis.activeClients} / ${kpis.maxClients === 9999 ? '∞' : kpis.maxClients} client slots used`;
}

function renderBookOfBusiness(clients) {
  const container = document.querySelector('#book-of-business');
  if (!container) return;

  if (!clients.length) {
    container.innerHTML = EMPTY('🏢', 'No clients yet', 'Add your first contractor client using the button above. Setup takes 3 minutes.', '<a href="#" onclick="openModal()" style="background:#F5C800;color:#111;font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:14px;letter-spacing:.3px;text-transform:uppercase;padding:9px 20px;border-radius:5px;text-decoration:none;">+ Add First Client</a>');
    return;
  }

  const avatarColors = ['#F97316','#60A5FA','#F5C800','#22C55E','#A78BFA','#EC4899','#14B8A6'];
  const getColor = (name) => avatarColors[name.charCodeAt(0) % avatarColors.length];

  container.innerHTML = clients.map((c, i) => `
    <div class="bob-row" onclick="viewClient('${c.id}')" style="animation-delay:${i * 0.04}s">
      <div class="bob-avatar" style="background:${getColor(c.businessName)}22;color:${getColor(c.businessName)}">
        ${c.avatarInitial}
      </div>
      <div>
        <div class="bob-biz">${escHtml(c.businessName)}</div>
        <div class="bob-trade">${c.trade} · ${c.city}, ${c.state}</div>
      </div>
      <div class="bob-mrr">$400</div>
      <div class="bob-agents">
        ${['receptionist','estimator','collector','marketer','rep'].map(type => {
          const agent = c.agents.find(a => a.type === type);
          return `<div class="bob-agent-dot ${agent?.isLive ? 'dot-live' : ''}" style="${!agent?.isLive ? 'background:#2E2E2E' : ''}"></div>`;
        }).join('')}
      </div>
      <div>
        ${c.onboardingDone
          ? '<span class="badge badge-live">ACTIVE</span>'
          : `<span class="badge badge-o">STEP ${c.onboardingStep}/6</span>`}
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();viewClient('${c.id}')">View</button>
        ${!c.onboardingDone ? `<button class="btn btn-y btn-sm" onclick="event.stopPropagation();resumeOnboarding('${c.id}')">Setup</button>` : ''}
      </div>
    </div>`).join('');

  window.viewClient = (id) => {
    window.location.href = `/partner/clients/${id}`;
  };
  window.resumeOnboarding = (id) => {
    window.location.href = `/onboarding?contractor=${id}`;
  };
}

function showLicenseeSkeletons() {
  setHTML('#book-of-business', SKELETON(5));
  setHTML('#licensee-activity-feed', SKELETON(6));
}

// ============================================================
// ── SHARED HELPERS ────────────────────────────────────────
// ============================================================

function outcomeColor(outcome) {
  return { booked: '#22C55E', transferred: '#60A5FA', callback: '#7A8A9A', not_interested: '#7A8A9A', voicemail: '#7A8A9A' }[outcome] || '#7A8A9A';
}

function outcomeBadgeClass(outcome) {
  return { booked: 'badge-live', transferred: 'badge-b', callback: 'badge-sl', not_interested: 'badge-sl' }[outcome] || 'badge-sl';
}

function statusBadge(status) {
  return { completed: 'badge-live', in_progress: 'badge-y', scheduled: 'badge-b', quoted: 'badge-sl', inquiry: 'badge-sl' }[status] || 'badge-sl';
}

function statusLabel(status) {
  return { completed: 'Done', in_progress: 'Active', scheduled: 'Booked', quoted: 'Quoted', inquiry: 'Inquiry' }[status] || status;
}

function formatDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Make toast available globally for inline onclick handlers
window.showToast = toast;
