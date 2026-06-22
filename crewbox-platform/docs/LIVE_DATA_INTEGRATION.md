# CrewBox — Live Data Integration Guide
## Connecting the dashboards to real Supabase data

---

## What Was Built

Three files that form a complete data layer:

### `frontend/api/supabase-client.js`
The Supabase connection singleton. Handles auth, sessions, token refresh, role detection. Import this everywhere — never create a second Supabase client.

### `frontend/api/crewbox-api.js`
Every data query the dashboards need. Returns clean shaped objects so the UI never touches raw Supabase response shapes. Includes real-time subscription functions for live feed updates.

### `frontend/api/dashboard-loader.js`
The bridge. Call `initContractorDashboard()` or `initLicenseeDashboard()` from either dashboard. It handles auth checking, parallel data loading, skeleton states, empty states, error states, render, and real-time subscriptions.

---

## Two Changes to Each Dashboard HTML File

### Step 1 — Add `id` attributes to your HTML elements
The loader uses `querySelector` with these IDs to inject data. Add them to the existing dashboard HTML:

#### Contractor Dashboard (`dashboard.html`)
```html
<!-- Top bar -->
<div class="dash-tlogo">
  <span id="dashboard-biz-name">Loading...</span>
</div>
<div class="dash-avatar" id="dashboard-avatar">?</div>
<div class="dash-uname" id="dashboard-user-name">Loading...</div>

<!-- Optional: onboarding banner (add above KPIs) -->
<div id="onboarding-banner"></div>

<!-- KPI cards — add IDs to the value elements -->
<div class="kv y" id="kpi-revenue">...</div>
<div class="kv w" id="kpi-calls">...</div>
<div class="kv r" id="kpi-outstanding">...</div>
<div class="kv y" id="kpi-rating">...</div>
<div class="kd" id="kpi-booking-rate">...</div>
<div class="kd" id="kpi-overdue-count">...</div>

<!-- Agent cards container -->
<div class="agents-row" id="agent-cards">
  <!-- Rendered dynamically by loader -->
</div>

<!-- Tab content containers -->
<div id="calls-feed"><!-- skeleton shown here --></div>
<div id="jobs-feed"><!-- skeleton shown here --></div>
<div id="invoices-feed"><!-- skeleton shown here --></div>
<div id="activity-feed"><!-- skeleton shown here --></div>
<div id="reviews-feed"><!-- skeleton shown here --></div>

<!-- Sign out buttons -->
<button data-signout>Sign Out</button>
```

#### Licensee Portal (`licensee-portal.html`)
```html
<!-- Brand name in header -->
<div id="licensee-brand-name">Loading...</div>
<div class="dash-av" id="licensee-avatar">?</div>
<div class="dash-uname" id="licensee-user-name">Loading...</div>

<!-- KPI cards -->
<div class="kv y" id="lkpi-mrr">...</div>
<div class="kv w" id="lkpi-clients">...</div>
<div class="kv g" id="lkpi-calls">...</div>
<div class="kv y" id="lkpi-recovered">...</div>
<div class="kv y" id="lkpi-net">...</div>
<div class="kd" id="lkpi-margin">...</div>

<!-- Book of Business table body -->
<div class="bob-grid" id="book-of-business">
  <!-- Rendered dynamically -->
</div>

<!-- Activity feed -->
<div class="feed" id="licensee-activity-feed">
  <!-- Rendered dynamically -->
</div>

<!-- Sidebar plan bar -->
<div class="sf-bar" id="plan-capacity-bar" style="width:0%"></div>
<div class="sf-count" id="plan-capacity-count">Loading...</div>

<!-- Sign out -->
<button data-signout>Sign Out</button>
```

---

### Step 2 — Add two script tags to the bottom of each HTML file

#### Contractor Dashboard (`dashboard.html`)
Replace the entire `<script>` block at the bottom with:
```html
<!-- Supabase config — inject at deploy time or via window globals -->
<script>
  window.CREWBOX_SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';
  window.CREWBOX_SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
</script>

<!-- Load the dashboard -->
<script type="module">
  import { initContractorDashboard } from './api/dashboard-loader.js';
  initContractorDashboard();
</script>
```

#### Licensee Portal (`licensee-portal.html`)
```html
<script>
  window.CREWBOX_SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';
  window.CREWBOX_SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
</script>

<script type="module">
  import { initLicenseeDashboard } from './api/dashboard-loader.js';
  initLicenseeDashboard();
</script>
```

---

## What Happens Automatically After Integration

### On page load:
1. Auth check — if no session, redirect to `/auth`
2. Role check — wrong role redirected to correct dashboard
3. Skeleton loading states shown immediately (no blank flash)
4. All data loaded in parallel (not sequentially)
5. Data rendered into the correct elements
6. Real-time subscriptions started

### In real time (no page refresh needed):
- New call comes in → feed updates + KPIs refresh + toast notification
- Invoice paid → invoices list updates + KPIs refresh
- Agent action → activity feed prepends new event
- Agent toggled on/off → agent cards re-render

### Empty states:
- No calls yet → helpful message with next steps
- No invoices → explanation of how they're created
- No reviews → Google connect CTA
- No clients (licensee) → Add first client CTA

### Error states:
- Network error → error message with retry button
- Auth error → redirect to login
- Permission error → redirect to correct dashboard

---

## Supabase Setup Checklist

Before the loader will work, complete these steps:

```
☐ 1. Create Supabase project at supabase.com
       Copy: Project URL + anon key

☐ 2. Run migrations in Supabase SQL Editor:
       - Paste 001_schema.sql → Run
       - Paste 002_rls_policies.sql → Run
       Verify: Tables appear in Table Editor

☐ 3. Enable Realtime for these tables:
       Dashboard → Database → Replication
       Enable: activity_log, calls, invoices, reviews

☐ 4. Set up Auth:
       Dashboard → Auth → Settings
       - Site URL: https://getcrewbox.com
       - Redirect URLs: https://getcrewbox.com/auth/callback
       - Enable Email confirmations
       - Enable Google OAuth (paste Google credentials)

☐ 5. Create a test user:
       Dashboard → Auth → Users → Invite user
       Set app_metadata: { "role": "contractor", "contractor_id": "..." }

☐ 6. Test the connection:
       Open dashboard.html in browser
       Check browser console for [CrewBox] logs
       Should see data load within 1-2 seconds
```

---

## File Structure After Integration

```
crewbox-platform/
├── frontend/
│   ├── api/
│   │   ├── supabase-client.js    ← Supabase singleton + auth helpers
│   │   ├── crewbox-api.js        ← All data queries + real-time
│   │   └── dashboard-loader.js   ← Connects dashboards to data
│   ├── dashboard.html            ← Contractor dashboard (add IDs)
│   ├── licensee-portal.html      ← Licensee portal (add IDs)
│   └── auth.html                 ← Login/signup (already complete)
```

---

## Deployment to Vercel

```bash
# 1. Push to GitHub
git add .
git commit -m "Add live data layer"
git push

# 2. Connect to Vercel
# - Go to vercel.com → New Project → Import from GitHub
# - Framework: Other (plain HTML)
# - Build: none
# - Output directory: frontend/

# 3. Add environment variables in Vercel dashboard:
#    CREWBOX_SUPABASE_URL      = https://xxx.supabase.co
#    CREWBOX_SUPABASE_ANON_KEY = eyJ...

# 4. Set custom domain:
#    getcrewbox.com → app.getcrewbox.com (dashboard subdomain)
#    Add CNAME record at your registrar
```

---

## What's Left After This

```
Priority 1 (needed to collect money):
  ☐ Customer invoice payment page
  ☐ Customer quote accept page

Priority 2 (needed for agent value):
  ☐ Email system (Resend integration)
  ☐ Document upload UI
  ☐ Google/Facebook OAuth connect flow

Priority 3 (growth):
  ☐ Mobile PWA
  ☐ Calendar integration
  ☐ Analytics + monthly reports
  ☐ Sub-licensee management
```
