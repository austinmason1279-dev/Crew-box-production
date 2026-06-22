// ============================================================
// CREWBOX — AUTHENTICATION & AUTHORIZATION
// File: auth/auth-service.js
//
// Three user types, three JWT role claims:
//   platform_admin → CrewBox internal staff
//   licensee       → White-label partners
//   contractor     → The actual trade business owners
//
// Uses Supabase Auth + custom JWT claims
// RLS policies use these claims to enforce data isolation
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// LICENSEE SIGNUP
// Called when a new white-label partner joins CrewBox
// ============================================================

export async function createLicenseeAccount({
  email,
  password,
  companyName,
  ownerName,
  ownerPhone,
  brandName,
  tier = 'starter',
}) {
  // 1. Create Supabase auth user
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      name: ownerName,
      role: 'licensee',
    },
  });

  if (authError) throw new Error(`Auth error: ${authError.message}`);

  // 2. Generate unique slug from company name
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);

  // 3. Create licensee record
  const { data: licensee, error: dbError } = await supabase
    .from('licensees')
    .insert({
      company_name: companyName,
      slug: `${slug}-${Date.now().toString(36)}`,  // ensure uniqueness
      owner_name: ownerName,
      owner_email: email,
      owner_phone: ownerPhone,
      brand_name: brandName || companyName,
      subscription_tier: tier,
      subscription_status: 'trialing',
      max_contractor_accounts: tier === 'starter' ? 10 : tier === 'growth' ? 50 : 9999,
    })
    .select()
    .single();

  if (dbError) throw new Error(`Database error: ${dbError.message}`);

  // 4. Link auth user to licensee
  await supabase
    .from('licensee_users')
    .insert({
      licensee_id: licensee.id,
      auth_user_id: authData.user.id,
      name: ownerName,
      email,
      role: 'admin',
    });

  // 5. Set custom JWT claims so RLS policies work
  await setUserClaims(authData.user.id, {
    role: 'licensee',
    licensee_id: licensee.id,
  });

  return {
    userId: authData.user.id,
    licenseeId: licensee.id,
    slug: licensee.slug,
  };
}

// ============================================================
// CONTRACTOR ACCOUNT
// Created by the licensee when they onboard a new client
// Contractor gets optional login to view their own dashboard
// ============================================================

export async function createContractorAccount({
  licenseeId,
  businessName,
  ownerName,
  ownerEmail,
  ownerPhone,
  tradeType,
  addressCity,
  addressState,
  createLogin = false,   // contractor login is optional
}) {
  // 1. Create contractor DB record (always happens)
  const { data: contractor, error: dbError } = await supabase
    .from('contractors')
    .insert({
      licensee_id: licenseeId,
      business_name: businessName,
      owner_name: ownerName,
      owner_email: ownerEmail,
      owner_phone: ownerPhone,
      trade_type: tradeType,
      address_city: addressCity,
      address_state: addressState,
      onboarding_complete: false,
      onboarding_step: 1,
    })
    .select()
    .single();

  if (dbError) throw new Error(`Database error: ${dbError.message}`);

  // 2. Create AI agent configs for all 5 agents (start in 'configuring' state)
  const agentTypes = ['receptionist', 'estimator', 'collector', 'marketer', 'rep'];
  await supabase.from('agent_configs').insert(
    agentTypes.map(type => ({
      contractor_id: contractor.id,
      agent_type: type,
      status: 'configuring',
      settings: getDefaultAgentSettings(type),
    }))
  );

  // 3. Optionally create a login for the contractor
  if (createLogin && ownerEmail) {
    const tempPassword = generateTempPassword();

    const { data: authData } = await supabase.auth.admin.createUser({
      email: ownerEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: {
        name: ownerName,
        role: 'contractor',
        business_name: businessName,
      },
    });

    if (authData?.user) {
      // Link auth user to contractor
      await supabase
        .from('contractors')
        .update({ auth_user_id: authData.user.id })
        .eq('id', contractor.id);

      // Set JWT claims
      await setUserClaims(authData.user.id, {
        role: 'contractor',
        contractor_id: contractor.id,
        licensee_id: licenseeId,
      });

      return {
        contractorId: contractor.id,
        authUserId: authData.user.id,
        tempPassword,  // send to contractor via SMS/email
        hasLogin: true,
      };
    }
  }

  return {
    contractorId: contractor.id,
    hasLogin: false,
  };
}

// ============================================================
// SET JWT CLAIMS
// Custom claims are injected into every token
// RLS policies read these to enforce tenant isolation
// ============================================================

export async function setUserClaims(userId, claims) {
  // Supabase stores custom claims in app_metadata
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: claims,
  });

  if (error) throw new Error(`Failed to set claims: ${error.message}`);
}

// ============================================================
// LOGIN
// ============================================================

export async function loginUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw new Error('Invalid credentials');

  const role = data.user.app_metadata?.role;
  const redirectPath = role === 'platform_admin' ? '/admin'
    : role === 'licensee' ? '/dashboard'
    : role === 'contractor' ? '/my-business'
    : '/';

  return {
    session: data.session,
    user: data.user,
    role,
    redirectPath,
  };
}

// ============================================================
// MIDDLEWARE — verify session + inject user context
// Use this in every API route
// ============================================================

export async function requireAuth(request, allowedRoles = ['platform_admin', 'licensee', 'contractor']) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing authorization header');
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) throw new Error('Invalid or expired token');

  const role = user.app_metadata?.role;
  if (!allowedRoles.includes(role)) {
    throw new Error(`Access denied. Required roles: ${allowedRoles.join(', ')}`);
  }

  return {
    userId: user.id,
    email: user.email,
    role,
    licenseeId: user.app_metadata?.licensee_id,
    contractorId: user.app_metadata?.contractor_id,
  };
}

// ============================================================
// ROLE-SPECIFIC MIDDLEWARE HELPERS
// ============================================================

export const requireLicensee = (req) =>
  requireAuth(req, ['platform_admin', 'licensee']);

export const requireContractor = (req) =>
  requireAuth(req, ['platform_admin', 'licensee', 'contractor']);

export const requirePlatformAdmin = (req) =>
  requireAuth(req, ['platform_admin']);

// ============================================================
// ONBOARDING PROGRESS TRACKING
// ============================================================

export async function updateOnboardingStep(contractorId, step) {
  const stepConfigs = {
    1: { label: 'Business Info', complete: false },
    2: { label: 'Phone Setup', complete: false },
    3: { label: 'Agent Configuration', complete: false },
    4: { label: 'Stripe Connect', complete: false },
    5: { label: 'Document Upload', complete: false },
    6: { label: 'Go Live', complete: true },
  };

  await supabase.from('contractors').update({
    onboarding_step: step,
    onboarding_complete: step >= 6,
  }).eq('id', contractorId);

  return stepConfigs[step] || { label: 'Unknown', complete: false };
}

export async function getOnboardingStatus(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      onboarding_step,
      onboarding_complete,
      owner_phone,
      ai_phone_number,
      stripe_onboarding_complete,
      agent_configs (agent_type, status)
    `)
    .eq('id', contractorId)
    .single();

  const { data: documents } = await supabase
    .from('documents')
    .select('document_type')
    .eq('contractor_id', contractorId)
    .in('document_type', ['contractor_license', 'insurance_certificate']);

  const steps = [
    {
      step: 1,
      label: 'Business Info',
      complete: !!contractor.owner_phone,
    },
    {
      step: 2,
      label: 'Phone Setup',
      complete: !!contractor.ai_phone_number,
    },
    {
      step: 3,
      label: 'AI Agents Configured',
      complete: contractor.agent_configs?.every(a => a.status === 'active') || false,
    },
    {
      step: 4,
      label: 'Payments Connected',
      complete: contractor.stripe_onboarding_complete || false,
    },
    {
      step: 5,
      label: 'Documents Uploaded',
      complete: documents && documents.length >= 1,
    },
    {
      step: 6,
      label: 'Live',
      complete: contractor.onboarding_complete || false,
    },
  ];

  const completedSteps = steps.filter(s => s.complete).length;
  const percentComplete = Math.round((completedSteps / steps.length) * 100);

  return {
    currentStep: contractor.onboarding_step,
    steps,
    percentComplete,
    isComplete: contractor.onboarding_complete,
  };
}

// ============================================================
// HELPERS
// ============================================================

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getDefaultAgentSettings(agentType) {
  const defaults = {
    receptionist: {
      max_call_duration_minutes: 10,
      transfer_keywords: ['emergency', 'urgent', 'speak to owner', 'human'],
      booking_confirmation_sms: true,
      collect_address: true,
      collect_problem_description: true,
    },
    estimator: {
      auto_send_delay_minutes: 0,   // send immediately
      follow_up_hours: 24,
      follow_up_count: 2,
      include_terms: true,
      valid_days: 30,
    },
    collector: {
      first_reminder_days_after_due: 1,
      second_reminder_days_after_due: 7,
      third_reminder_days_after_due: 14,
      final_reminder_days_after_due: 30,
      primary_channel: 'sms',       // sms | email
      escalate_to_licensee: true,   // alert licensee on final reminder
    },
    marketer: {
      post_frequency: 'weekly',
      platforms: ['google_business', 'facebook'],
      auto_hashtags: true,
      watermark: false,
    },
    rep: {
      auto_respond_to_positive: true,
      auto_respond_to_negative: false,  // flag for human review first
      review_request_delay_hours: 24,   // wait 24hrs after job completion
      review_request_channel: 'sms',
      max_requests_per_customer: 1,     // never spam
    },
  };
  return defaults[agentType] || {};
}
