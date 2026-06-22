// ============================================================
// CREWBOX — COMPLETE EMAIL SERVICE
// File: email/service/email-service.js
//
// Handles every email CrewBox sends using Resend.
// White-label aware — emails come from the LICENSEE's
// sender name and domain, not from CrewBox.
//
// 8 Email Types:
//   1. contractor_welcome      → New contractor onboarded
//   2. invoice_delivery        → Customer receives invoice
//   3. invoice_reminder        → Overdue payment reminder
//   4. invoice_receipt         → Payment confirmation
//   5. quote_delivery          → Customer receives quote
//   6. quote_accepted          → Contractor notified of acceptance
//   7. document_expiry_alert   → License/insurance expiring soon
//   8. licensee_welcome        → New licensee joins CrewBox
//
// All emails are:
//   - Mobile-responsive HTML
//   - Sent from licensee's domain (white-label)
//   - Stored in activity_log after send
//   - Retry on failure (Resend handles delivery)
// ============================================================

import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
import {
  contractorWelcomeTemplate,
  invoiceDeliveryTemplate,
  invoiceReminderTemplate,
  invoiceReceiptTemplate,
  quoteDeliveryTemplate,
  quoteAcceptedTemplate,
  documentExpiryTemplate,
  licenseeWelcomeTemplate,
} from './email-templates.js';

const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── DEFAULT SENDER (used when licensee has no custom domain) ──
const DEFAULT_FROM = 'CrewBox <noreply@getcrewbox.com>';

// ============================================================
// CORE SEND FUNCTION
// All emails flow through here — handles white-labeling,
// logging, retry logic, and error reporting.
// ============================================================

async function sendEmail({
  to,
  subject,
  html,
  text,
  contractorId = null,
  licenseeId   = null,
  emailType,
  relatedEntityId   = null,
  relatedEntityType = null,
}) {
  // Get licensee branding for white-label sender
  const fromAddress = await getFromAddress(licenseeId);

  try {
    const result = await resend.emails.send({
      from:    fromAddress,
      to:      Array.isArray(to) ? to : [to],
      subject,
      html,
      text:    text || stripHtml(html),
      headers: {
        'X-CrewBox-Type':       emailType,
        'X-CrewBox-Contractor': contractorId || '',
      },
    });

    // Log successful send
    await logEmail(contractorId, licenseeId, emailType, to, subject, 'sent', result.id, relatedEntityId, relatedEntityType);

    return { success: true, id: result.id };

  } catch (err) {
    console.error(`[CrewBox Email] Failed to send ${emailType} to ${to}:`, err.message);

    // Log failure
    await logEmail(contractorId, licenseeId, emailType, to, subject, 'failed', null, relatedEntityId, relatedEntityType);

    throw new Error(`Email delivery failed: ${err.message}`);
  }
}

// ============================================================
// 1. CONTRACTOR WELCOME EMAIL
// Sent when licensee adds a new contractor
// ============================================================

export async function sendContractorWelcome(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      *,
      licensees ( brand_name, brand_primary_color, custom_domain, owner_email )
    `)
    .eq('id', contractorId)
    .single();

  if (!contractor?.owner_email) return { skipped: true, reason: 'No email address' };

  const html = contractorWelcomeTemplate({
    ownerName:    contractor.owner_name,
    businessName: contractor.business_name,
    trade:        contractor.trade_type,
    aiPhone:      contractor.ai_phone_number,
    setupUrl:     `${getAppUrl(contractor.licensees)}/setup`,
    dashUrl:      `${getAppUrl(contractor.licensees)}/my-business`,
    brandName:    contractor.licensees?.brand_name || 'CrewBox',
    primaryColor: contractor.licensees?.brand_primary_color || '#F5C800',
  });

  return sendEmail({
    to:          contractor.owner_email,
    subject:     `Welcome to ${contractor.licensees?.brand_name || 'CrewBox'} — Your AI crew is ready`,
    html,
    contractorId,
    licenseeId:  contractor.licensee_id,
    emailType:   'contractor_welcome',
    relatedEntityId:   contractorId,
    relatedEntityType: 'contractor',
  });
}

// ============================================================
// 2. INVOICE DELIVERY EMAIL
// Sent by the Collector agent when invoice is created
// ============================================================

export async function sendInvoiceEmail(invoiceId) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select(`
      *,
      contractors (
        business_name, owner_phone,
        licensees ( brand_name, brand_primary_color, custom_domain )
      ),
      customers ( name, email, phone )
    `)
    .eq('id', invoiceId)
    .single();

  const email = invoice.customers?.email;
  if (!email) return { skipped: true, reason: 'Customer has no email' };

  const paymentUrl = invoice.stripe_payment_link_url ||
    `${getAppUrl(invoice.contractors?.licensees)}/pay/${invoiceId}`;

  const html = invoiceDeliveryTemplate({
    customerName:   invoice.customers?.name || 'Valued Customer',
    businessName:   invoice.contractors?.business_name,
    invoiceNumber:  invoice.invoice_number,
    invoiceTitle:   invoice.title,
    lineItems:      invoice.line_items || [],
    subtotal:       invoice.subtotal,
    taxAmount:      invoice.tax_amount,
    total:          invoice.total_amount,
    dueDate:        invoice.due_date,
    paymentUrl,
    brandName:      invoice.contractors?.licensees?.brand_name || 'CrewBox',
    primaryColor:   invoice.contractors?.licensees?.brand_primary_color || '#F5C800',
    businessPhone:  invoice.contractors?.owner_phone,
  });

  const result = await sendEmail({
    to:          email,
    subject:     `Invoice ${invoice.invoice_number} from ${invoice.contractors?.business_name} — $${Number(invoice.total_amount).toFixed(2)} due`,
    html,
    contractorId: invoice.contractor_id,
    licenseeId:   null,
    emailType:    'invoice_delivery',
    relatedEntityId:   invoiceId,
    relatedEntityType: 'invoice',
  });

  // Update invoice sent timestamp
  if (result.success) {
    await supabase.from('invoices').update({
      sent_at: new Date().toISOString(),
      status:  invoice.status === 'draft' ? 'sent' : invoice.status,
    }).eq('id', invoiceId);
  }

  return result;
}

// ============================================================
// 3. INVOICE REMINDER EMAIL
// Sent by the Collector agent for overdue invoices
// ============================================================

export async function sendInvoiceReminderEmail(invoiceId, reminderNumber = 1) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select(`
      *,
      contractors (
        business_name, owner_name, owner_phone,
        licensees ( brand_name, brand_primary_color, custom_domain )
      ),
      customers ( name, email, phone )
    `)
    .eq('id', invoiceId)
    .single();

  const email = invoice.customers?.email;
  if (!email) return { skipped: true, reason: 'Customer has no email' };

  const daysOverdue = Math.floor(
    (Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24)
  );

  const tone = reminderNumber === 1 ? 'friendly' : reminderNumber <= 3 ? 'firm' : 'final';
  const paymentUrl = invoice.stripe_payment_link_url ||
    `${getAppUrl(invoice.contractors?.licensees)}/pay/${invoiceId}`;

  const html = invoiceReminderTemplate({
    customerName:   invoice.customers?.name || 'Valued Customer',
    businessName:   invoice.contractors?.business_name,
    businessPhone:  invoice.contractors?.owner_phone,
    invoiceNumber:  invoice.invoice_number,
    amountDue:      invoice.amount_due,
    daysOverdue,
    reminderNumber,
    tone,
    paymentUrl,
    brandName:      invoice.contractors?.licensees?.brand_name || 'CrewBox',
    primaryColor:   invoice.contractors?.licensees?.brand_primary_color || '#F5C800',
  });

  const subjects = {
    friendly: `Friendly reminder — Invoice ${invoice.invoice_number} is due`,
    firm:     `Invoice ${invoice.invoice_number} is ${daysOverdue} days past due`,
    final:    `Final notice — Invoice ${invoice.invoice_number} requires immediate payment`,
  };

  return sendEmail({
    to:          email,
    subject:     subjects[tone],
    html,
    contractorId: invoice.contractor_id,
    emailType:   'invoice_reminder',
    relatedEntityId:   invoiceId,
    relatedEntityType: 'invoice',
  });
}

// ============================================================
// 4. INVOICE RECEIPT EMAIL
// Sent to customer after successful payment
// ============================================================

export async function sendPaymentReceiptEmail(invoiceId, paymentId) {
  const [invoiceRes, paymentRes] = await Promise.all([
    supabase.from('invoices')
      .select(`*, contractors(business_name,owner_phone,licensees(brand_name,brand_primary_color,custom_domain)), customers(name,email)`)
      .eq('id', invoiceId).single(),
    supabase.from('payments')
      .select('amount, net_amount, payment_method, paid_at, stripe_charge_id')
      .eq('id', paymentId).single(),
  ]);

  const invoice = invoiceRes.data;
  const payment = paymentRes.data;
  const email   = invoice?.customers?.email;

  if (!email) return { skipped: true, reason: 'Customer has no email' };

  const html = invoiceReceiptTemplate({
    customerName:   invoice.customers?.name,
    businessName:   invoice.contractors?.business_name,
    businessPhone:  invoice.contractors?.owner_phone,
    invoiceNumber:  invoice.invoice_number,
    lineItems:      invoice.line_items || [],
    subtotal:       invoice.subtotal,
    taxAmount:      invoice.tax_amount,
    total:          invoice.total_amount,
    amountPaid:     payment.amount,
    paymentMethod:  formatPaymentMethod(payment.payment_method),
    paidAt:         payment.paid_at,
    referenceId:    payment.stripe_charge_id,
    brandName:      invoice.contractors?.licensees?.brand_name || 'CrewBox',
    primaryColor:   invoice.contractors?.licensees?.brand_primary_color || '#F5C800',
  });

  return sendEmail({
    to:          email,
    subject:     `Payment confirmed — ${invoice.contractors?.business_name} · $${Number(invoice.total_amount).toFixed(2)}`,
    html,
    contractorId: invoice.contractor_id,
    emailType:   'invoice_receipt',
    relatedEntityId:   invoiceId,
    relatedEntityType: 'invoice',
  });
}

// ============================================================
// 5. QUOTE DELIVERY EMAIL
// Sent by the Estimator agent with PDF attachment
// ============================================================

export async function sendQuoteEmail(quoteId) {
  const { data: quote } = await supabase
    .from('quotes')
    .select(`
      *,
      contractors (
        business_name, owner_phone, owner_name,
        licensees ( brand_name, brand_primary_color, custom_domain )
      ),
      customers ( name, email )
    `)
    .eq('id', quoteId)
    .single();

  const email = quote.customers?.email;
  if (!email) return { skipped: true, reason: 'Customer has no email' };

  const quoteUrl    = `${getAppUrl(quote.contractors?.licensees)}/quote/${quoteId}`;
  const acceptUrl   = `${getAppUrl(quote.contractors?.licensees)}/quote/${quoteId}?action=accept`;
  const declineUrl  = `${getAppUrl(quote.contractors?.licensees)}/quote/${quoteId}?action=decline`;

  const html = quoteDeliveryTemplate({
    customerName:   quote.customers?.name || 'Valued Customer',
    businessName:   quote.contractors?.business_name,
    businessPhone:  quote.contractors?.owner_phone,
    ownerName:      quote.contractors?.owner_name,
    quoteNumber:    quote.quote_number,
    quoteTitle:     quote.title,
    description:    quote.description,
    lineItems:      quote.line_items || [],
    subtotal:       quote.subtotal,
    taxAmount:      quote.tax_amount,
    total:          quote.total_amount,
    validUntil:     quote.expires_at,
    quoteUrl,
    acceptUrl,
    declineUrl,
    brandName:      quote.contractors?.licensees?.brand_name || 'CrewBox',
    primaryColor:   quote.contractors?.licensees?.brand_primary_color || '#F5C800',
  });

  const result = await sendEmail({
    to:          email,
    subject:     `Your quote from ${quote.contractors?.business_name} — $${Number(quote.total_amount).toFixed(2)}`,
    html,
    contractorId: quote.contractor_id,
    emailType:   'quote_delivery',
    relatedEntityId:   quoteId,
    relatedEntityType: 'quote',
  });

  if (result.success) {
    await supabase.from('quotes').update({
      sent_at: new Date().toISOString(),
      sent_via: ['email'],
      status: 'sent',
    }).eq('id', quoteId);
  }

  return result;
}

// ============================================================
// 6. QUOTE ACCEPTED NOTIFICATION
// Sent to contractor when customer accepts a quote
// ============================================================

export async function sendQuoteAcceptedNotification(quoteId) {
  const { data: quote } = await supabase
    .from('quotes')
    .select(`
      *,
      contractors ( business_name, owner_email, owner_name ),
      customers ( name, phone, email )
    `)
    .eq('id', quoteId)
    .single();

  const contractorEmail = quote.contractors?.owner_email;
  if (!contractorEmail) return { skipped: true, reason: 'Contractor has no email' };

  const html = quoteAcceptedTemplate({
    ownerName:      quote.contractors?.owner_name,
    businessName:   quote.contractors?.business_name,
    customerName:   quote.customers?.name,
    customerPhone:  quote.customers?.phone,
    quoteNumber:    quote.quote_number,
    total:          quote.total_amount,
    dashUrl:        `${process.env.APP_URL}/my-business`,
  });

  return sendEmail({
    to:          contractorEmail,
    subject:     `✅ Quote accepted — ${quote.customers?.name} approved $${Number(quote.total_amount).toFixed(2)}`,
    html,
    contractorId: quote.contractor_id,
    emailType:   'quote_accepted',
    relatedEntityId:   quoteId,
    relatedEntityType: 'quote',
  });
}

// ============================================================
// 7. DOCUMENT EXPIRY ALERT
// Sent 30 days and 7 days before license/insurance expires
// ============================================================

export async function sendDocumentExpiryAlert(documentId) {
  const { data: doc } = await supabase
    .from('documents')
    .select(`
      *,
      contractors (
        business_name, owner_name, owner_email,
        licensees ( brand_name, owner_email )
      )
    `)
    .eq('id', documentId)
    .single();

  const daysUntilExpiry = Math.ceil(
    (new Date(doc.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)
  );

  const html = documentExpiryTemplate({
    ownerName:        doc.contractors?.owner_name,
    businessName:     doc.contractors?.business_name,
    documentType:     formatDocType(doc.document_type),
    expiryDate:       doc.expiry_date,
    daysUntilExpiry,
    uploadUrl:        `${process.env.APP_URL}/my-business?tab=documents`,
    brandName:        'CrewBox',
  });

  const results = [];

  // Alert the contractor
  if (doc.contractors?.owner_email) {
    results.push(await sendEmail({
      to:          doc.contractors.owner_email,
      subject:     `⚠️ ${formatDocType(doc.document_type)} expires in ${daysUntilExpiry} days — ${doc.contractors?.business_name}`,
      html,
      contractorId: doc.contractor_id,
      emailType:   'document_expiry_alert',
      relatedEntityId:   documentId,
      relatedEntityType: 'document',
    }));
  }

  // Also alert the licensee
  if (doc.contractors?.licensees?.owner_email) {
    results.push(await sendEmail({
      to:          doc.contractors.licensees.owner_email,
      subject:     `⚠️ Client document expiring — ${doc.contractors?.business_name}`,
      html,
      licenseeId:  null,
      emailType:   'document_expiry_alert',
    }));
  }

  return results;
}

// ============================================================
// 8. LICENSEE WELCOME EMAIL
// Sent when a new licensee signs up for CrewBox
// ============================================================

export async function sendLicenseeWelcome(licenseeId) {
  const { data: licensee } = await supabase
    .from('licensees')
    .select('*')
    .eq('id', licenseeId)
    .single();

  if (!licensee?.owner_email) return { skipped: true };

  const html = licenseeWelcomeTemplate({
    ownerName:    licensee.owner_name,
    companyName:  licensee.company_name,
    tier:         licensee.subscription_tier,
    maxClients:   licensee.max_contractor_accounts,
    portalUrl:    `${process.env.APP_URL}/partner`,
    trialEndsAt:  licensee.trial_ends_at,
  });

  return sendEmail({
    to:        licensee.owner_email,
    subject:   `Welcome to CrewBox — your white-label AI platform is ready`,
    html,
    licenseeId,
    emailType: 'licensee_welcome',
    relatedEntityId:   licenseeId,
    relatedEntityType: 'licensee',
  });
}

// ============================================================
// BATCH FUNCTIONS (called by cron jobs)
// ============================================================

/**
 * Send all pending document expiry alerts.
 * Run daily at 8am.
 */
export async function processDocumentExpiryAlerts() {
  const today = new Date();
  const in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in7   = new Date(today.getTime() + 7  * 24 * 60 * 60 * 1000);

  const { data: expiring } = await supabase
    .from('documents')
    .select('id, expiry_date, document_type')
    .in('document_type', ['contractor_license', 'insurance_certificate'])
    .or(`expiry_date.eq.${formatDate(in30)},expiry_date.eq.${formatDate(in7)}`);

  const results = [];
  for (const doc of (expiring || [])) {
    try {
      const res = await sendDocumentExpiryAlert(doc.id);
      results.push({ docId: doc.id, ...res });
    } catch (e) {
      results.push({ docId: doc.id, error: e.message });
    }
  }
  return results;
}

/**
 * Send all overdue invoice reminders via email.
 * Run daily at 8am (after SMS reminders).
 */
export async function processEmailReminders() {
  const now = new Date();

  const { data: overdue } = await supabase
    .from('invoices')
    .select('id, reminder_count')
    .in('status', ['sent', 'overdue'])
    .lt('due_date', now.toISOString().split('T')[0])
    .lt('reminder_count', 5);

  const results = [];
  for (const inv of (overdue || [])) {
    try {
      const res = await sendInvoiceReminderEmail(inv.id, (inv.reminder_count || 0) + 1);
      results.push({ invoiceId: inv.id, ...res });
    } catch (e) {
      results.push({ invoiceId: inv.id, error: e.message });
    }
  }
  return results;
}

// ============================================================
// HELPERS
// ============================================================

async function getFromAddress(licenseeId) {
  if (!licenseeId) return DEFAULT_FROM;

  const { data: licensee } = await supabase
    .from('licensees')
    .select('brand_name, custom_domain')
    .eq('id', licenseeId)
    .single();

  if (!licensee) return DEFAULT_FROM;

  const domain   = licensee.custom_domain || 'getcrewbox.com';
  const brand    = licensee.brand_name    || 'CrewBox';
  return `${brand} <noreply@${domain}>`;
}

function getAppUrl(licensee) {
  if (licensee?.custom_domain) return `https://${licensee.custom_domain}`;
  return process.env.APP_URL || 'https://app.getcrewbox.com';
}

async function logEmail(contractorId, licenseeId, type, to, subject, status, resendId, entityId, entityType) {
  try {
    await supabase.from('activity_log').insert({
      contractor_id: contractorId,
      licensee_id:   licenseeId,
      agent:         'system',
      action:        `email_${status}`,
      entity_type:   entityType,
      entity_id:     entityId,
      description:   `${type} email ${status}: "${subject}" → ${to}`,
      metadata:      { resend_id: resendId, email_type: type, to },
    });
  } catch (e) { /* non-fatal */ }
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatPaymentMethod(method) {
  const map = { card: 'Credit / Debit Card', ach: 'Bank Transfer (ACH)', apple_pay: 'Apple Pay', google_pay: 'Google Pay', cash: 'Cash', check: 'Check' };
  return map[method] || method || 'Card';
}

function formatDocType(type) {
  const map = { contractor_license: 'Contractor License', insurance_certificate: 'Insurance Certificate', business_registration: 'Business Registration', w9: 'W-9 Tax Form' };
  return map[type] || type;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}
