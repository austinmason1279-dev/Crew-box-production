// ============================================================
// CREWBOX — COMPLETE API LAYER
// File: frontend/api/crewbox-api.js
//
// Every data query the dashboards need — in one clean module.
// All queries respect RLS (users only see their own data).
// All functions return clean shaped objects — dashboards never
// touch raw Supabase response shapes directly.
// ============================================================

import { supabase, handleSupabaseError, dateRanges } from './supabase-client.js';

// ============================================================
// ── CONTRACTOR QUERIES ────────────────────────────────────
// ============================================================

/**
 * Get the full contractor profile for the logged-in user.
 * Used to populate dashboard header, agent configs, phone setup status.
 */
export async function getContractorProfile(contractorId) {
  const { data, error } = await supabase
    .from('contractors')
    .select(`
      id, business_name, owner_name, owner_email, owner_phone,
      trade_type, trade_specialty,
      address_city, address_state,
      ai_phone_number, existing_phone_number,
      stripe_connect_account_id, stripe_onboarding_complete,
      stripe_charges_enabled, stripe_payouts_enabled,
      onboarding_complete, onboarding_step,
      business_hours, service_area_description,
      contractor_license_number, license_expiry_date,
      insurance_expiry_date, is_active,
      created_at
    `)
    .eq('id', contractorId)
    .single();

  handleSupabaseError(error, 'getContractorProfile');
  return data;
}

/**
 * Update contractor profile fields.
 */
export async function updateContractorProfile(contractorId, updates) {
  const { data, error } = await supabase
    .from('contractors')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', contractorId)
    .select()
    .single();

  handleSupabaseError(error, 'updateContractorProfile');
  return data;
}

// ============================================================
// ── CONTRACTOR KPIs ───────────────────────────────────────
// ============================================================

/**
 * Get all KPI data for the contractor dashboard header row.
 * Single aggregated query — minimizes round trips.
 */
export async function getContractorKPIs(contractorId) {
  const { start, end } = dateRanges.thisMonth();

  const [paymentsRes, callsRes, invoicesRes, reviewsRes] = await Promise.all([
    // Revenue this month
    supabase
      .from('payments')
      .select('amount, net_amount')
      .eq('contractor_id', contractorId)
      .eq('status', 'succeeded')
      .gte('paid_at', start)
      .lte('paid_at', end),

    // Calls this month
    supabase
      .from('calls')
      .select('outcome, appointment_booked')
      .eq('contractor_id', contractorId)
      .gte('started_at', start)
      .lte('started_at', end),

    // Outstanding invoices
    supabase
      .from('invoices')
      .select('amount_due, status')
      .eq('contractor_id', contractorId)
      .in('status', ['sent', 'overdue']),

    // Review average
    supabase
      .from('reviews')
      .select('rating')
      .eq('contractor_id', contractorId)
      .not('rating', 'is', null),
  ]);

  const revenue     = paymentsRes.data?.reduce((s, p) => s + Number(p.amount), 0) || 0;
  const netRevenue  = paymentsRes.data?.reduce((s, p) => s + Number(p.net_amount || p.amount), 0) || 0;
  const callsTotal  = callsRes.data?.length || 0;
  const callsBooked = callsRes.data?.filter(c => c.appointment_booked).length || 0;
  const outstanding = invoicesRes.data?.reduce((s, i) => s + Number(i.amount_due), 0) || 0;
  const overdueCount = invoicesRes.data?.filter(i => i.status === 'overdue').length || 0;
  const ratings     = reviewsRes.data?.map(r => r.rating).filter(Boolean) || [];
  const avgRating   = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0;

  return {
    revenueMonth:    revenue,
    netRevenueMonth: netRevenue,
    callsMonth:      callsTotal,
    callsBooked,
    bookingRate:     callsTotal ? Math.round((callsBooked / callsTotal) * 100) : 0,
    outstanding,
    overdueCount,
    avgRating:       Math.round(avgRating * 10) / 10,
    reviewCount:     ratings.length,
  };
}

// ============================================================
// ── CALLS ─────────────────────────────────────────────────
// ============================================================

/**
 * Get recent calls for contractor dashboard.
 */
export async function getRecentCalls(contractorId, limit = 10) {
  const { data, error } = await supabase
    .from('calls')
    .select(`
      id, caller_name, caller_phone, direction,
      duration_seconds, outcome, summary,
      appointment_booked, transferred_to,
      started_at, ended_at,
      customers ( name, phone )
    `)
    .eq('contractor_id', contractorId)
    .order('started_at', { ascending: false })
    .limit(limit);

  handleSupabaseError(error, 'getRecentCalls');
  return (data || []).map(shapCall);
}

/**
 * Get call analytics for a date range.
 */
export async function getCallAnalytics(contractorId, days = 30) {
  const { start } = dateRanges.lastNDays(days);

  const { data, error } = await supabase
    .from('calls')
    .select('outcome, duration_seconds, appointment_booked, started_at')
    .eq('contractor_id', contractorId)
    .gte('started_at', start);

  handleSupabaseError(error, 'getCallAnalytics');

  const calls = data || [];
  const byOutcome = calls.reduce((acc, c) => {
    const k = c.outcome || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return {
    total:       calls.length,
    booked:      calls.filter(c => c.appointment_booked).length,
    bookingRate: calls.length ? Math.round((calls.filter(c => c.appointment_booked).length / calls.length) * 100) : 0,
    avgDuration: calls.length ? Math.round(calls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / calls.length) : 0,
    byOutcome,
    period: `Last ${days} days`,
  };
}

// Shaper: raw call → clean dashboard object
function shapCall(c) {
  return {
    id:               c.id,
    name:             c.caller_name || c.customers?.name || 'Unknown Caller',
    phone:            c.caller_phone || c.customers?.phone || '',
    outcome:          c.outcome || 'callback',
    summary:          c.summary || '',
    booked:           c.appointment_booked || false,
    durationSeconds:  c.duration_seconds || 0,
    durationDisplay:  formatDuration(c.duration_seconds),
    timeAgo:          timeAgo(c.started_at),
    startedAt:        c.started_at,
  };
}

// ============================================================
// ── JOBS ──────────────────────────────────────────────────
// ============================================================

/**
 * Get recent jobs for contractor dashboard.
 */
export async function getRecentJobs(contractorId, limit = 8) {
  const { data, error } = await supabase
    .from('jobs')
    .select(`
      id, title, description, status, priority,
      scheduled_start, scheduled_end,
      quoted_amount, final_amount,
      service_address, service_city,
      created_at,
      customers ( id, name, phone )
    `)
    .eq('contractor_id', contractorId)
    .order('created_at', { ascending: false })
    .limit(limit);

  handleSupabaseError(error, 'getRecentJobs');
  return (data || []).map(j => ({
    id:           j.id,
    title:        j.title,
    customer:     j.customers?.name || 'Unknown',
    customerId:   j.customers?.id,
    status:       j.status,
    priority:     j.priority,
    amount:       j.final_amount || j.quoted_amount || 0,
    address:      j.service_address || j.service_city || '',
    scheduledAt:  j.scheduled_start,
    dateDisplay:  formatJobDate(j.scheduled_start),
    createdAt:    j.created_at,
  }));
}

// ============================================================
// ── INVOICES ──────────────────────────────────────────────
// ============================================================

/**
 * Get open invoices (sent + overdue) for contractor dashboard.
 */
export async function getOpenInvoices(contractorId) {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, title,
      total_amount, amount_due, amount_paid,
      status, due_date, sent_at, paid_at,
      reminder_count, last_reminder_sent_at,
      stripe_payment_link_url,
      customers ( id, name, phone, email )
    `)
    .eq('contractor_id', contractorId)
    .in('status', ['draft', 'sent', 'overdue'])
    .order('due_date', { ascending: true });

  handleSupabaseError(error, 'getOpenInvoices');
  return (data || []).map(i => ({
    id:             i.id,
    number:         i.invoice_number,
    title:          i.title,
    customer:       i.customers?.name || 'Unknown',
    customerId:     i.customers?.id,
    customerPhone:  i.customers?.phone,
    customerEmail:  i.customers?.email,
    total:          Number(i.total_amount),
    amountDue:      Number(i.amount_due),
    amountPaid:     Number(i.amount_paid),
    status:         i.status,
    dueDate:        i.due_date,
    daysOverdue:    daysOverdue(i.due_date),
    reminderCount:  i.reminder_count || 0,
    paymentLink:    i.stripe_payment_link_url,
    isOverdue:      i.status === 'overdue' || daysOverdue(i.due_date) > 0,
  }));
}

/**
 * Get paid invoices for payment history.
 */
export async function getPaidInvoices(contractorId, limit = 20) {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, total_amount, paid_at,
      customers ( name )
    `)
    .eq('contractor_id', contractorId)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(limit);

  handleSupabaseError(error, 'getPaidInvoices');
  return data || [];
}

/**
 * Get financial summary for a period.
 */
export async function getFinancialSummary(contractorId, days = 30) {
  const { start } = dateRanges.lastNDays(days);

  const [paidRes, overdueRes, payoutsRes] = await Promise.all([
    supabase.from('payments')
      .select('amount, net_amount, stripe_fee, platform_fee')
      .eq('contractor_id', contractorId)
      .eq('status', 'succeeded')
      .gte('paid_at', start),
    supabase.from('invoices')
      .select('amount_due')
      .eq('contractor_id', contractorId)
      .eq('status', 'overdue'),
    supabase.from('payouts')
      .select('amount, arrival_date, status')
      .eq('contractor_id', contractorId)
      .order('arrival_date', { ascending: false })
      .limit(5),
  ]);

  const collected  = paidRes.data?.reduce((s, p) => s + Number(p.amount), 0) || 0;
  const net        = paidRes.data?.reduce((s, p) => s + Number(p.net_amount || p.amount), 0) || 0;
  const fees       = collected - net;
  const overdue    = overdueRes.data?.reduce((s, i) => s + Number(i.amount_due), 0) || 0;

  return {
    collected, net, fees, overdue,
    recentPayouts: payoutsRes.data || [],
    period: `Last ${days} days`,
  };
}

// ============================================================
// ── AGENTS ────────────────────────────────────────────────
// ============================================================

/**
 * Get all agent configs + live status for a contractor.
 */
export async function getAgentStatuses(contractorId) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('agent_type, status, settings, last_active_at, vapi_assistant_id')
    .eq('contractor_id', contractorId)
    .order('agent_type');

  handleSupabaseError(error, 'getAgentStatuses');

  const META = {
    receptionist: { icon: '📞', name: 'The Receptionist', role: 'Voice + SMS · 24/7' },
    estimator:    { icon: '📋', name: 'The Estimator',    role: 'Instant Quote Engine' },
    collector:    { icon: '💰', name: 'The Collector',    role: 'Invoice Recovery' },
    marketer:     { icon: '📱', name: 'The Marketer',     role: 'Social Autopilot' },
    rep:          { icon: '⭐', name: 'The Rep',          role: 'Reputation Guard' },
  };

  return (data || []).map(a => ({
    type:        a.agent_type,
    ...META[a.agent_type],
    status:      a.status,
    isLive:      a.status === 'active',
    settings:    a.settings || {},
    lastActive:  a.last_active_at ? timeAgo(a.last_active_at) : 'Never',
    hasVapi:     !!a.vapi_assistant_id,
  }));
}

/**
 * Update a single agent's settings.
 */
export async function updateAgentSettings(contractorId, agentType, settings) {
  const { data, error } = await supabase
    .from('agent_configs')
    .update({ settings, updated_at: new Date().toISOString() })
    .eq('contractor_id', contractorId)
    .eq('agent_type', agentType)
    .select()
    .single();

  handleSupabaseError(error, 'updateAgentSettings');
  return data;
}

/**
 * Toggle agent on/off.
 */
export async function toggleAgent(contractorId, agentType, active) {
  const newStatus = active ? 'active' : 'paused';
  const { data, error } = await supabase
    .from('agent_configs')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('contractor_id', contractorId)
    .eq('agent_type', agentType)
    .select()
    .single();

  handleSupabaseError(error, 'toggleAgent');
  return data;
}

// ============================================================
// ── ACTIVITY LOG ──────────────────────────────────────────
// ============================================================

/**
 * Get recent activity for contractor dashboard feed.
 */
export async function getContractorActivity(contractorId, limit = 20) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('id, agent, action, entity_type, entity_id, description, amount, created_at, metadata')
    .eq('contractor_id', contractorId)
    .order('created_at', { ascending: false })
    .limit(limit);

  handleSupabaseError(error, 'getContractorActivity');
  return (data || []).map(shapeActivity);
}

// ============================================================
// ── REVIEWS ───────────────────────────────────────────────
// ============================================================

/**
 * Get reviews for contractor reputation dashboard.
 */
export async function getReviews(contractorId, limit = 20) {
  const { data, error } = await supabase
    .from('reviews')
    .select(`
      id, platform, reviewer_name, rating, review_text,
      review_date, response_text, responded_at,
      ai_generated_response, response_approved,
      request_sent_at,
      customers ( name )
    `)
    .eq('contractor_id', contractorId)
    .order('review_date', { ascending: false })
    .limit(limit);

  handleSupabaseError(error, 'getReviews');
  return (data || []).map(r => ({
    id:               r.id,
    platform:         r.platform,
    reviewer:         r.reviewer_name || r.customers?.name || 'A Customer',
    rating:           r.rating,
    text:             r.review_text || '',
    date:             r.review_date,
    dateDisplay:      timeAgo(r.review_date),
    responded:        !!r.responded_at,
    response:         r.response_text,
    needsApproval:    r.ai_generated_response && !r.response_approved,
    isNegative:       (r.rating || 5) <= 2,
    stars:            '★'.repeat(r.rating || 0) + '☆'.repeat(5 - (r.rating || 0)),
  }));
}

/**
 * Get reputation stats summary.
 */
export async function getReputationStats(contractorId) {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating, platform, responded_at, review_date')
    .eq('contractor_id', contractorId);

  handleSupabaseError(error, 'getReputationStats');

  const reviews = data || [];
  const ratings = reviews.map(r => r.rating).filter(Boolean);
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const responded = reviews.filter(r => r.responded_at).length;

  const byPlatform = reviews.reduce((acc, r) => {
    if (!acc[r.platform]) acc[r.platform] = { count: 0, total: 0 };
    acc[r.platform].count++;
    acc[r.platform].total += r.rating || 0;
    return acc;
  }, {});
  Object.values(byPlatform).forEach(p => { p.avg = Math.round((p.total / p.count) * 10) / 10; });

  return {
    total:        reviews.length,
    avgRating:    Math.round(avg * 10) / 10,
    responded,
    responseRate: reviews.length ? Math.round((responded / reviews.length) * 100) : 0,
    byPlatform,
  };
}

// ============================================================
// ── DOCUMENTS ─────────────────────────────────────────────
// ============================================================

/**
 * Get contractor documents with expiry status.
 */
export async function getDocuments(contractorId) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, document_type, file_name, file_size_bytes, expiry_date, is_verified, uploaded_at, description')
    .eq('contractor_id', contractorId)
    .order('uploaded_at', { ascending: false });

  handleSupabaseError(error, 'getDocuments');

  const today = new Date();
  const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  return (data || []).map(d => ({
    ...d,
    isExpiringSoon: d.expiry_date && new Date(d.expiry_date) <= in30Days,
    isExpired:      d.expiry_date && new Date(d.expiry_date) < today,
    expiryDisplay:  d.expiry_date ? formatDate(d.expiry_date) : null,
    sizeDisplay:    formatBytes(d.file_size_bytes),
  }));
}

// ============================================================
// ── LICENSEE QUERIES ──────────────────────────────────────
// ============================================================

/**
 * Get licensee profile.
 */
export async function getLicenseeProfile(licenseeId) {
  const { data, error } = await supabase
    .from('licensees')
    .select(`
      id, company_name, slug, brand_name,
      brand_logo_url, brand_primary_color, brand_secondary_color,
      custom_domain, subscription_tier, subscription_status,
      trial_ends_at, max_contractor_accounts, current_contractor_count,
      allow_sub_licensees, is_active, created_at,
      stripe_customer_id, stripe_subscription_id
    `)
    .eq('id', licenseeId)
    .single();

  handleSupabaseError(error, 'getLicenseeProfile');
  return data;
}

/**
 * Get all contractors under a licensee — the "Book of Business".
 */
export async function getLicenseeClients(licenseeId) {
  const { data, error } = await supabase
    .from('contractors')
    .select(`
      id, business_name, owner_name, owner_phone, owner_email,
      trade_type, address_city, address_state,
      is_active, onboarding_complete, onboarding_step,
      stripe_charges_enabled, created_at,
      agent_configs ( agent_type, status )
    `)
    .eq('licensee_id', licenseeId)
    .order('created_at', { ascending: false });

  handleSupabaseError(error, 'getLicenseeClients');

  return (data || []).map(c => ({
    id:              c.id,
    businessName:    c.business_name,
    ownerName:       c.owner_name,
    phone:           c.owner_phone,
    email:           c.owner_email,
    trade:           c.trade_type,
    city:            c.address_city,
    state:           c.address_state,
    isActive:        c.is_active,
    onboardingDone:  c.onboarding_complete,
    onboardingStep:  c.onboarding_step,
    paymentEnabled:  c.stripe_charges_enabled,
    avatarInitial:   c.business_name[0].toUpperCase(),
    agents:          (c.agent_configs || []).map(a => ({
      type:   a.agent_type,
      isLive: a.status === 'active',
    })),
    liveAgentCount:  (c.agent_configs || []).filter(a => a.status === 'active').length,
    joinedAt:        c.created_at,
  }));
}

/**
 * Get licensee dashboard KPIs — aggregated across all their contractors.
 */
export async function getLicenseeKPIs(licenseeId) {
  const { start } = dateRanges.thisMonth();

  // Get all contractor IDs for this licensee first
  const { data: contractors } = await supabase
    .from('contractors')
    .select('id')
    .eq('licensee_id', licenseeId)
    .eq('is_active', true);

  const contractorIds = contractors?.map(c => c.id) || [];
  if (!contractorIds.length) {
    return { mrr: 0, activeClients: 0, callsMonth: 0, revenueRecovered: 0 };
  }

  const [callsRes, paymentsRes] = await Promise.all([
    supabase.from('calls')
      .select('id, appointment_booked')
      .in('contractor_id', contractorIds)
      .gte('started_at', start),
    supabase.from('payments')
      .select('amount')
      .in('contractor_id', contractorIds)
      .eq('status', 'succeeded')
      .gte('paid_at', start),
  ]);

  const { data: licensee } = await supabase
    .from('licensees')
    .select('current_contractor_count, subscription_tier')
    .eq('id', licenseeId)
    .single();

  const tierPricing = { starter: 297, growth: 597, enterprise: 1497 };
  const avgClientFee = 400; // licensee charges ~$400/client

  return {
    mrr:              (licensee?.current_contractor_count || 0) * avgClientFee,
    activeClients:    licensee?.current_contractor_count || 0,
    maxClients:       licensee?.subscription_tier === 'starter' ? 10 : licensee?.subscription_tier === 'growth' ? 50 : 9999,
    callsMonth:       callsRes.data?.length || 0,
    callsBooked:      callsRes.data?.filter(c => c.appointment_booked).length || 0,
    revenueRecovered: paymentsRes.data?.reduce((s, p) => s + Number(p.amount), 0) || 0,
    licenseFee:       tierPricing[licensee?.subscription_tier] || 597,
    netProfit:        ((licensee?.current_contractor_count || 0) * avgClientFee) - (tierPricing[licensee?.subscription_tier] || 597),
  };
}

/**
 * Get cross-licensee activity feed — every agent action across all clients.
 */
export async function getLicenseeActivity(licenseeId, limit = 30) {
  // Get contractor IDs
  const { data: contractors } = await supabase
    .from('contractors')
    .select('id')
    .eq('licensee_id', licenseeId);

  const ids = contractors?.map(c => c.id) || [];
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from('activity_log')
    .select(`
      id, agent, action, description, amount, created_at,
      contractors ( business_name )
    `)
    .in('contractor_id', ids)
    .order('created_at', { ascending: false })
    .limit(limit);

  handleSupabaseError(error, 'getLicenseeActivity');

  return (data || []).map(a => ({
    ...shapeActivity(a),
    businessName: a.contractors?.business_name || 'Unknown',
  }));
}

// ============================================================
// ── REALTIME SUBSCRIPTIONS ────────────────────────────────
// ============================================================

/**
 * Subscribe to live activity for contractor dashboard feed.
 * Returns an unsubscribe function — call it on page unload.
 *
 * Usage:
 *   const unsub = subscribeToActivity(contractorId, (event) => {
 *     prependToFeed(event);
 *   });
 *   // Later:
 *   unsub();
 */
export function subscribeToActivity(contractorId, onNewEvent) {
  const channel = supabase
    .channel(`activity:${contractorId}`)
    .on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'activity_log',
        filter: `contractor_id=eq.${contractorId}`,
      },
      (payload) => onNewEvent(shapeActivity(payload.new))
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

/**
 * Subscribe to new calls in real time.
 */
export function subscribeToNewCalls(contractorId, onNewCall) {
  const channel = supabase
    .channel(`calls:${contractorId}`)
    .on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'calls',
        filter: `contractor_id=eq.${contractorId}`,
      },
      (payload) => onNewCall(shapCall(payload.new))
    )
    .on(
      'postgres_changes',
      {
        event:  'UPDATE',
        schema: 'public',
        table:  'calls',
        filter: `contractor_id=eq.${contractorId}`,
      },
      (payload) => onNewCall(shapCall(payload.new))
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

/**
 * Subscribe to invoice status changes.
 */
export function subscribeToInvoices(contractorId, onUpdate) {
  const channel = supabase
    .channel(`invoices:${contractorId}`)
    .on(
      'postgres_changes',
      {
        event:  '*',
        schema: 'public',
        table:  'invoices',
        filter: `contractor_id=eq.${contractorId}`,
      },
      (payload) => onUpdate(payload)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

/**
 * Subscribe to licensee activity across ALL their clients.
 * Uses a more broad filter — events from any contractor under this licensee.
 */
export function subscribeToLicenseeActivity(contractorIds, onNewEvent) {
  if (!contractorIds.length) return () => {};

  // Supabase Realtime supports `in` filter for a list
  const channel = supabase
    .channel(`licensee-activity`)
    .on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'activity_log',
      },
      (payload) => {
        // Client-side filter since Realtime `in` isn't always available
        if (contractorIds.includes(payload.new.contractor_id)) {
          onNewEvent(shapeActivity(payload.new));
        }
      }
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

// ============================================================
// ── MUTATIONS ─────────────────────────────────────────────
// ============================================================

/**
 * Manually trigger an invoice reminder (bypasses scheduled cron).
 * Calls the backend API endpoint.
 */
export async function sendManualReminder(invoiceId) {
  const response = await fetch(`/api/invoices/${invoiceId}/remind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${(await getSession())?.access_token}`,
    },
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to send reminder');
  }

  return response.json();
}

/**
 * Approve and post an AI-generated review response.
 */
export async function approveReviewResponse(reviewId) {
  const { data, error } = await supabase
    .from('reviews')
    .update({ response_approved: true, responded_at: new Date().toISOString() })
    .eq('id', reviewId)
    .select()
    .single();

  handleSupabaseError(error, 'approveReviewResponse');
  return data;
}

// ============================================================
// ── SHAPE + FORMAT HELPERS ────────────────────────────────
// ============================================================

function shapeActivity(a) {
  const agentMeta = {
    receptionist: { icon: '📞', color: '#22C55E' },
    estimator:    { icon: '📋', color: '#F5C800' },
    collector:    { icon: '💰', color: '#F5C800' },
    marketer:     { icon: '📱', color: '#60A5FA' },
    rep:          { icon: '⭐', color: '#22C55E' },
    system:       { icon: '⚙️', color: '#7A8A9A' },
  };

  const meta = agentMeta[a.agent] || agentMeta.system;

  return {
    id:          a.id,
    agent:       a.agent,
    agentIcon:   meta.icon,
    agentColor:  meta.color,
    agentLabel:  `${meta.icon} ${(a.agent || 'system').charAt(0).toUpperCase() + (a.agent || 'system').slice(1)}`,
    action:      a.action,
    description: a.description,
    amount:      a.amount ? Number(a.amount) : null,
    amountDisplay: a.amount ? `$${Number(a.amount).toLocaleString()}` : null,
    timeAgo:     timeAgo(a.created_at),
    createdAt:   a.created_at,
    metadata:    a.metadata || {},
  };
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'Just now';
  if (mins  < 60) return `${mins} min ago`;
  if (hours < 24) return `${hours} hr ago`;
  if (days  < 7)  return `${days} days ago`;
  return formatDate(dateStr);
}

function formatDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function daysOverdue(dueDateStr) {
  if (!dueDateStr) return 0;
  const diff = Date.now() - new Date(dueDateStr).getTime();
  return Math.max(0, Math.floor(diff / 86400000));
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatJobDate(dateStr) {
  if (!dateStr) return 'Unscheduled';
  const d = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === today.toDateString())    return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1048576)    return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Import getSession for mutations
import { getSession } from './supabase-client.js';
