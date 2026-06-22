// ============================================================
// CREWBOX — SUPABASE CLIENT
// File: frontend/api/supabase-client.js
//
// Single source of truth for the Supabase connection.
// Handles: session, auth state, token refresh, role detection.
// Import this wherever Supabase is needed — never instantiate
// the client more than once.
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── CONFIG ───────────────────────────────────────────────
// These are the only two values you swap at deploy time.
// In production: inject via environment variables.
const SUPABASE_URL      = window.CREWBOX_SUPABASE_URL      || 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = window.CREWBOX_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';

// ── CLIENT SINGLETON ─────────────────────────────────────
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken:    true,
    persistSession:      true,
    detectSessionInUrl:  true,   // handles magic links + OAuth callbacks
    storageKey:          'crewbox_session',
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
  global: {
    headers: { 'x-application': 'crewbox-web' },
  },
});

// ── SESSION HELPERS ───────────────────────────────────────

/**
 * Get the current authenticated session.
 * Returns null if not logged in.
 */
export async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) console.error('[CrewBox] Session error:', error.message);
  return session;
}

/**
 * Get the current user with their role + IDs from app_metadata.
 * This is the source of truth for role-based UI decisions.
 */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  const user = session.user;
  const meta = user.app_metadata || {};

  return {
    id:           user.id,
    email:        user.email,
    name:         user.user_metadata?.name || user.email,
    role:         meta.role || 'contractor',           // 'contractor' | 'licensee' | 'platform_admin'
    contractorId: meta.contractor_id || null,
    licenseeId:   meta.licensee_id   || null,
    avatarInitial: (user.user_metadata?.name || user.email || 'U')[0].toUpperCase(),
  };
}

/**
 * Require auth — redirect to login if no session.
 * Call this at the top of every protected page.
 */
export async function requireAuth(allowedRoles = null) {
  const user = await getCurrentUser();

  if (!user) {
    window.location.href = '/auth';
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    window.location.href = user.role === 'licensee' ? '/partner' : '/my-business';
    return null;
  }

  return user;
}

/**
 * Sign out and redirect to login.
 */
export async function signOut() {
  await supabase.auth.signOut();
  localStorage.removeItem('crewbox_session');
  window.location.href = '/auth';
}

/**
 * Listen for auth state changes.
 * Useful for handling token expiry, session refresh, magic link callbacks.
 */
export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}

// ── ERROR HANDLER ─────────────────────────────────────────
/**
 * Standardized error handling for all Supabase queries.
 * Throws a clean Error with the Supabase message.
 */
export function handleSupabaseError(error, context = '') {
  if (!error) return;
  const msg = error.message || 'Unknown database error';
  console.error(`[CrewBox${context ? ` / ${context}` : ''}]`, msg);
  throw new Error(msg);
}

// ── QUERY HELPERS ─────────────────────────────────────────
/**
 * Date range helpers for common filter patterns.
 */
export const dateRanges = {
  today: () => {
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = new Date(); end.setHours(23,59,59,999);
    return { start: start.toISOString(), end: end.toISOString() };
  },
  thisMonth: () => {
    const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end   = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);
    return { start: start.toISOString(), end: end.toISOString() };
  },
  lastNDays: (n) => {
    const start = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: new Date().toISOString() };
  },
};
