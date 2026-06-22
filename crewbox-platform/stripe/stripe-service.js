// ============================================================
// CREWBOX — STRIPE CONNECT INTEGRATION
// File: stripe/stripe-service.js
//
// Handles:
//   1. Contractor onboarding (Connected Accounts)
//   2. Invoice payment links
//   3. Payment collection + splits
//   4. Payout tracking
//   5. Webhook handling
//   6. Licensee subscription billing
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role bypasses RLS for backend writes
);

// ============================================================
// PART 1: LICENSEE SUBSCRIPTIONS
// CrewBox billing licensees monthly
// ============================================================

export const LICENSEE_PLANS = {
  starter: {
    name: 'CrewBox Starter',
    price_id: process.env.STRIPE_STARTER_PRICE_ID,   // $297/mo
    monthly_fee: 297,
    max_contractors: 10,
  },
  growth: {
    name: 'CrewBox Growth',
    price_id: process.env.STRIPE_GROWTH_PRICE_ID,    // $597/mo
    monthly_fee: 597,
    max_contractors: 50,
  },
  enterprise: {
    name: 'CrewBox Enterprise',
    price_id: process.env.STRIPE_ENTERPRISE_PRICE_ID, // $1497/mo
    monthly_fee: 1497,
    max_contractors: null, // unlimited
  },
};

/**
 * Create a new licensee subscription
 * Called when a new licensee signs up
 */
export async function createLicenseeSubscription(licenseeId, tier, email, name) {
  // Create Stripe customer for licensee
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { licensee_id: licenseeId, platform: 'crewbox' },
  });

  // Create subscription with 14-day trial
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: LICENSEE_PLANS[tier].price_id }],
    trial_period_days: 14,
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: { licensee_id: licenseeId },
  });

  // Store in database
  await supabase.from('licensees').update({
    stripe_customer_id: customer.id,
    stripe_subscription_id: subscription.id,
    subscription_status: 'trialing',
  }).eq('id', licenseeId);

  return {
    customerId: customer.id,
    subscriptionId: subscription.id,
    clientSecret: subscription.latest_invoice.payment_intent?.client_secret,
  };
}

// ============================================================
// PART 2: CONTRACTOR ONBOARDING (Stripe Connect)
// Sets up each contractor to accept payments
// ============================================================

/**
 * Step 1: Create a Connected Account for a contractor
 * This is called when the contractor is first added
 */
export async function createContractorConnectedAccount(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('owner_name, owner_email, owner_phone, address_state, trade_type, business_name')
    .eq('id', contractorId)
    .single();

  // Create Express account (fastest onboarding, Stripe handles KYC)
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: contractor.owner_email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
      us_bank_account_ach_payments: { requested: true },
    },
    business_type: 'individual',
    business_profile: {
      name: contractor.business_name,
      mcc: getMCC(contractor.trade_type),  // Merchant Category Code per trade
      url: null,
      product_description: `${contractor.trade_type} contracting services`,
    },
    metadata: {
      contractor_id: contractorId,
      platform: 'crewbox',
    },
  });

  // Save account ID to database
  await supabase.from('contractors').update({
    stripe_connect_account_id: account.id,
  }).eq('id', contractorId);

  return account.id;
}

/**
 * Step 2: Generate onboarding link for contractor
 * Contractor visits this URL to connect their bank + verify identity
 */
export async function getContractorOnboardingLink(contractorId, returnUrl) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('stripe_connect_account_id')
    .eq('id', contractorId)
    .single();

  if (!contractor.stripe_connect_account_id) {
    await createContractorConnectedAccount(contractorId);
    // Re-fetch
    const { data: updated } = await supabase
      .from('contractors')
      .select('stripe_connect_account_id')
      .eq('id', contractorId)
      .single();
    contractor.stripe_connect_account_id = updated.stripe_connect_account_id;
  }

  const accountLink = await stripe.accountLinks.create({
    account: contractor.stripe_connect_account_id,
    refresh_url: `${returnUrl}/stripe/refresh?contractor_id=${contractorId}`,
    return_url: `${returnUrl}/stripe/complete?contractor_id=${contractorId}`,
    type: 'account_onboarding',
  });

  return accountLink.url;
}

/**
 * Step 3: Check if contractor is fully onboarded
 * Called after they return from Stripe onboarding
 */
export async function checkContractorOnboardingStatus(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('stripe_connect_account_id')
    .eq('id', contractorId)
    .single();

  const account = await stripe.accounts.retrieve(contractor.stripe_connect_account_id);

  const isComplete = account.charges_enabled && account.payouts_enabled;

  await supabase.from('contractors').update({
    stripe_onboarding_complete: isComplete,
    stripe_charges_enabled: account.charges_enabled,
    stripe_payouts_enabled: account.payouts_enabled,
  }).eq('id', contractorId);

  return {
    complete: isComplete,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    requirements: account.requirements,
  };
}

// ============================================================
// PART 3: INVOICE PAYMENT LINKS
// Collector agent sends these to customers
// ============================================================

/**
 * Create a payment link for a specific invoice
 * This is what the Collector agent texts/emails to customers
 */
export async function createInvoicePaymentLink(invoiceId) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select(`
      *,
      contractors (
        business_name,
        stripe_connect_account_id,
        stripe_charges_enabled
      ),
      customers (
        name,
        email,
        phone
      )
    `)
    .eq('id', invoiceId)
    .single();

  if (!invoice.contractors.stripe_charges_enabled) {
    throw new Error('Contractor has not completed Stripe onboarding');
  }

  // Platform fee: optional 0.5% of invoice amount (can be 0)
  const platformFeeAmount = Math.round(invoice.total_amount * 100 * 0.005); // 0.5% in cents

  // Create payment intent on the contractor's Connected Account
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(invoice.total_amount * 100), // convert to cents
    currency: 'usd',
    customer: await getOrCreateStripeCustomer(invoice.customers, invoice.contractors.stripe_connect_account_id),
    payment_method_types: ['card', 'us_bank_account'],
    description: `Invoice ${invoice.invoice_number} — ${invoice.contractors.business_name}`,
    metadata: {
      invoice_id: invoiceId,
      contractor_id: invoice.contractor_id,
      invoice_number: invoice.invoice_number,
      customer_name: invoice.customers?.name,
    },
    // Route payment to contractor's account, take platform fee
    transfer_data: {
      destination: invoice.contractors.stripe_connect_account_id,
    },
    application_fee_amount: platformFeeAmount,
  }, {
    // This creates it as a platform charge (not direct charge)
    stripeAccount: undefined, // charge on platform, transfer to connected
  });

  // Create Stripe Payment Link (no-code checkout page)
  const price = await stripe.prices.create({
    currency: 'usd',
    unit_amount: Math.round(invoice.total_amount * 100),
    product_data: {
      name: `Invoice ${invoice.invoice_number}`,
      description: `Payment for services by ${invoice.contractors.business_name}`,
    },
  });

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    payment_method_types: ['card'],
    after_completion: {
      type: 'redirect',
      redirect: { url: `${process.env.APP_URL}/payment/thank-you?invoice=${invoiceId}` },
    },
    metadata: {
      invoice_id: invoiceId,
      contractor_id: invoice.contractor_id,
    },
  });

  // Update invoice with payment intent + link
  await supabase.from('invoices').update({
    stripe_payment_intent_id: paymentIntent.id,
    stripe_payment_link_url: paymentLink.url,
    status: 'sent',
    sent_at: new Date().toISOString(),
  }).eq('id', invoiceId);

  // Log activity
  await logActivity(invoice.contractor_id, 'collector', 'invoice_payment_link_created', 'invoice', invoiceId,
    `Payment link created for ${invoice.invoice_number} — $${invoice.total_amount}`, invoice.total_amount);

  return {
    paymentIntentId: paymentIntent.id,
    paymentLinkUrl: paymentLink.url,
    amount: invoice.total_amount,
  };
}

// ============================================================
// PART 4: WEBHOOK HANDLER
// Stripe calls this URL when payment events happen
// POST /api/webhooks/stripe
// ============================================================

export async function handleStripeWebhook(rawBody, signature) {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {

    // ── PAYMENT SUCCEEDED ──
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const invoiceId = pi.metadata.invoice_id;
      const contractorId = pi.metadata.contractor_id;

      if (!invoiceId) break;

      const amountPaid = pi.amount_received / 100;
      const stripeFee = pi.charges?.data[0]?.balance_transaction
        ? (await stripe.balanceTransactions.retrieve(pi.charges.data[0].balance_transaction)).fee / 100
        : 0;
      const platformFee = (pi.application_fee_amount || 0) / 100;
      const netAmount = amountPaid - stripeFee - platformFee;

      // Mark invoice paid
      await supabase.from('invoices').update({
        status: 'paid',
        amount_paid: amountPaid,
        paid_at: new Date().toISOString(),
        payment_method_used: pi.payment_method_types?.[0] || 'card',
      }).eq('id', invoiceId);

      // Record payment
      await supabase.from('payments').insert({
        contractor_id: contractorId,
        invoice_id: invoiceId,
        amount: amountPaid,
        platform_fee: platformFee,
        stripe_fee: stripeFee,
        net_amount: netAmount,
        stripe_payment_intent_id: pi.id,
        payment_method: pi.payment_method_types?.[0] || 'card',
        status: 'succeeded',
        paid_at: new Date().toISOString(),
      });

      // Log activity
      await logActivity(contractorId, 'collector', 'payment_received', 'invoice', invoiceId,
        `Payment of $${amountPaid} received`, amountPaid);

      break;
    }

    // ── PAYMENT FAILED ──
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const invoiceId = pi.metadata.invoice_id;
      if (!invoiceId) break;

      await supabase.from('invoices').update({
        status: 'overdue',
      }).eq('id', invoiceId);

      break;
    }

    // ── PAYOUT SENT TO CONTRACTOR ──
    case 'payout.paid': {
      const payout = event.data.object;
      // Find contractor by Stripe account ID (comes in event account field)
      const { data: contractor } = await supabase
        .from('contractors')
        .select('id')
        .eq('stripe_connect_account_id', event.account)
        .single();

      if (contractor) {
        await supabase.from('payouts').insert({
          contractor_id: contractor.id,
          stripe_payout_id: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: 'paid',
          arrival_date: new Date(payout.arrival_date * 1000).toISOString().split('T')[0],
        });
      }
      break;
    }

    // ── CONTRACTOR ACCOUNT UPDATED ──
    case 'account.updated': {
      const account = event.data.object;
      const { data: contractor } = await supabase
        .from('contractors')
        .select('id')
        .eq('stripe_connect_account_id', account.id)
        .single();

      if (contractor) {
        await supabase.from('contractors').update({
          stripe_charges_enabled: account.charges_enabled,
          stripe_payouts_enabled: account.payouts_enabled,
          stripe_onboarding_complete: account.charges_enabled && account.payouts_enabled,
        }).eq('id', contractor.id);
      }
      break;
    }

    // ── LICENSEE SUBSCRIPTION EVENTS ──
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const { data: licensee } = await supabase
        .from('licensees')
        .select('id')
        .eq('stripe_subscription_id', sub.id)
        .single();

      if (licensee) {
        const newStatus = sub.status === 'active' ? 'active'
          : sub.status === 'past_due' ? 'past_due'
          : sub.status === 'canceled' ? 'cancelled'
          : sub.status === 'trialing' ? 'trialing'
          : 'cancelled';

        await supabase.from('licensees').update({
          subscription_status: newStatus,
          is_active: ['active', 'trialing'].includes(sub.status),
        }).eq('id', licensee.id);
      }
      break;
    }

    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  return { received: true };
}

// ============================================================
// PART 5: INVOICE REMINDER AUTOMATION
// Called by the Collector agent on a schedule
// ============================================================

export async function sendInvoiceReminders() {
  const now = new Date();

  // Find all overdue invoices that need reminders
  const { data: overdueInvoices } = await supabase
    .from('invoices')
    .select(`
      *,
      contractors (business_name, owner_phone),
      customers (name, email, phone)
    `)
    .eq('status', 'sent')
    .lt('due_date', now.toISOString())
    .lt('next_reminder_at', now.toISOString())
    .lt('reminder_count', 4)  // max 4 reminders
    .order('due_date', { ascending: true });

  const results = [];

  for (const invoice of (overdueInvoices || [])) {
    const reminderNum = (invoice.reminder_count || 0) + 1;
    const daysOverdue = Math.floor((now - new Date(invoice.due_date)) / (1000 * 60 * 60 * 24));

    // Tone escalates with each reminder
    const tone = reminderNum === 1 ? 'friendly'
      : reminderNum === 2 ? 'firm'
      : 'final';

    const message = buildReminderMessage(
      invoice.contractors.business_name,
      invoice.customers?.name,
      invoice.invoice_number,
      invoice.amount_due,
      daysOverdue,
      tone,
      invoice.stripe_payment_link_url
    );

    // Calculate next reminder date
    const nextReminderDays = reminderNum === 1 ? 7 : reminderNum === 2 ? 7 : 14;
    const nextReminder = new Date(now);
    nextReminder.setDate(nextReminder.getDate() + nextReminderDays);

    // Log reminder in database
    await supabase.from('invoice_reminders').insert({
      invoice_id: invoice.id,
      contractor_id: invoice.contractor_id,
      reminder_number: reminderNum,
      tone,
      channel: invoice.customers?.phone ? 'sms' : 'email',
      message_body: message,
      sent_at: now.toISOString(),
    });

    // Update invoice reminder tracking
    await supabase.from('invoices').update({
      reminder_count: reminderNum,
      last_reminder_sent_at: now.toISOString(),
      next_reminder_at: reminderNum < 4 ? nextReminder.toISOString() : null,
      status: 'overdue',
    }).eq('id', invoice.id);

    await logActivity(invoice.contractor_id, 'collector', 'reminder_sent', 'invoice', invoice.id,
      `Reminder #${reminderNum} (${tone}) sent for ${invoice.invoice_number} — $${invoice.amount_due} overdue ${daysOverdue} days`);

    results.push({ invoiceId: invoice.id, reminderNum, tone });
  }

  return results;
}

// ============================================================
// PART 6: FINANCIAL REPORTING
// For contractor + licensee dashboards
// ============================================================

export async function getContractorFinancialSummary(contractorId, period = 'month') {
  const startDate = period === 'month'
    ? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    : new Date(new Date().getFullYear(), 0, 1);

  const { data: payments } = await supabase
    .from('payments')
    .select('amount, net_amount, stripe_fee, platform_fee, paid_at')
    .eq('contractor_id', contractorId)
    .eq('status', 'succeeded')
    .gte('paid_at', startDate.toISOString());

  const { data: outstanding } = await supabase
    .from('invoices')
    .select('amount_due')
    .eq('contractor_id', contractorId)
    .in('status', ['sent', 'overdue']);

  const totalCollected = payments?.reduce((sum, p) => sum + Number(p.amount), 0) || 0;
  const totalNet = payments?.reduce((sum, p) => sum + Number(p.net_amount), 0) || 0;
  const totalOutstanding = outstanding?.reduce((sum, i) => sum + Number(i.amount_due), 0) || 0;
  const totalFees = totalCollected - totalNet;

  return {
    period,
    totalCollected,
    totalNet,
    totalFees,
    totalOutstanding,
    paymentCount: payments?.length || 0,
  };
}

// ============================================================
// HELPERS
// ============================================================

function buildReminderMessage(businessName, customerName, invoiceNum, amount, daysOverdue, tone, paymentLink) {
  const messages = {
    friendly: `Hi ${customerName || 'there'}, this is a friendly reminder from ${businessName}. Invoice ${invoiceNum} for $${amount} was due ${daysOverdue} days ago. Pay securely here: ${paymentLink} — thank you!`,
    firm: `Hi ${customerName || 'there'}, ${businessName} here. Invoice ${invoiceNum} ($${amount}) is now ${daysOverdue} days past due. Please pay at your earliest convenience: ${paymentLink}`,
    final: `${customerName || 'Hi'}, this is a final notice from ${businessName}. Invoice ${invoiceNum} for $${amount} is ${daysOverdue} days overdue. Please pay immediately to avoid further action: ${paymentLink}`,
  };
  return messages[tone];
}

async function getOrCreateStripeCustomer(customer, connectedAccountId) {
  if (!customer?.email) return undefined;

  const existing = await stripe.customers.list(
    { email: customer.email, limit: 1 },
    { stripeAccount: connectedAccountId }
  );

  if (existing.data.length > 0) return existing.data[0].id;

  const newCustomer = await stripe.customers.create(
    { name: customer.name, email: customer.email, phone: customer.phone },
    { stripeAccount: connectedAccountId }
  );
  return newCustomer.id;
}

async function logActivity(contractorId, agent, action, entityType, entityId, description, amount = null) {
  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent,
    action,
    entity_type: entityType,
    entity_id: entityId,
    description,
    amount,
  });
}

// Merchant Category Codes by trade type
function getMCC(tradeType) {
  const mccs = {
    hvac: '7699',           // Repair Shops and Related Services
    plumbing: '1711',       // Plumbing, Heating Equipment, and Supplies
    electrical: '1731',     // Electrical Work
    roofing: '1761',        // Roofing, Siding, and Sheet Metal Work
    general_contractor: '1520', // General Building Contractors
    cleaning: '7349',       // Building Cleaning and Maintenance Services
    landscaping: '0780',    // Landscape and Horticultural Services
    auto_repair: '7538',    // Automotive Service Shops
    painting: '1721',       // Painting and Paper Hanging
    flooring: '5713',       // Floor Covering Stores
    pest_control: '7342',   // Exterminating Services
    appliance_repair: '7629', // Electrical and Small Appliance Repair
    other: '7699',
  };
  return mccs[tradeType] || '7699';
}
