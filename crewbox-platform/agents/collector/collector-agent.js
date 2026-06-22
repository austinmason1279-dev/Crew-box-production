// ============================================================
// CREWBOX — COLLECTOR AGENT
// File: agents/collector/collector-agent.js
//
// Tracks every open invoice and runs a smart reminder sequence.
// Tone escalates intelligently: friendly → firm → final.
// Never awkward, never aggressive — just consistent until paid.
//
// Schedule: Runs every morning at 6am via cron
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { createInvoicePaymentLink } from '../../stripe/stripe-service.js';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ============================================================
// PART 1: MAIN COLLECTION RUN
// Called daily by cron job
// ============================================================

export async function runCollectionCycle() {
  const now = new Date();
  const results = { processed: 0, reminded: 0, escalated: 0, errors: [] };

  // Find all invoices that need attention
  const { data: invoices } = await supabase
    .from('invoices')
    .select(`
      *,
      contractors (
        id, business_name, owner_name, owner_phone,
        stripe_connect_account_id, stripe_charges_enabled,
        licensees (brand_name)
      ),
      customers (id, name, email, phone)
    `)
    .in('status', ['sent', 'overdue'])
    .lt('due_date', now.toISOString().split('T')[0])
    .or('next_reminder_at.is.null,next_reminder_at.lte.' + now.toISOString())
    .lt('reminder_count', 5)
    .order('due_date', { ascending: true });

  for (const invoice of (invoices || [])) {
    try {
      await processInvoiceReminder(invoice, now);
      results.reminded++;
      if (invoice.reminder_count >= 2) results.escalated++;
    } catch (err) {
      results.errors.push({ invoiceId: invoice.id, error: err.message });
    }
    results.processed++;
  }

  // Also check for invoices that just became overdue today
  await markNewlyOverdueInvoices(now);

  return results;
}

// ============================================================
// PART 2: PROCESS A SINGLE INVOICE REMINDER
// ============================================================

async function processInvoiceReminder(invoice, now) {
  const reminderNum = (invoice.reminder_count || 0) + 1;
  const daysOverdue = Math.floor(
    (now - new Date(invoice.due_date)) / (1000 * 60 * 60 * 24)
  );

  // Determine tone based on reminder number
  const tone = reminderNum <= 1 ? 'friendly'
    : reminderNum <= 3 ? 'firm'
    : 'final';

  // Ensure payment link exists
  let paymentLink = invoice.stripe_payment_link_url;
  if (!paymentLink && invoice.contractors.stripe_charges_enabled) {
    const linkData = await createInvoicePaymentLink(invoice.id);
    paymentLink = linkData.paymentLinkUrl;
  }

  // Generate AI-personalized message
  const message = await generateCollectionMessage({
    businessName: invoice.contractors.business_name,
    ownerName: invoice.contractors.owner_name,
    customerName: invoice.customers?.name,
    invoiceNumber: invoice.invoice_number,
    amountDue: invoice.amount_due,
    daysOverdue,
    reminderNum,
    tone,
    paymentLink,
    jobDescription: invoice.title,
  });

  // Send via SMS (primary) and/or email
  const sentVia = [];
  const customerPhone = invoice.customers?.phone;
  const customerEmail = invoice.customers?.email;

  if (customerPhone) {
    await twilioClient.messages.create({
      to: customerPhone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: message.sms,
    });
    sentVia.push('sms');
  }

  // Calculate next reminder date
  const nextReminderDays = reminderNum === 1 ? 7
    : reminderNum === 2 ? 7
    : reminderNum === 3 ? 14
    : null; // no more after reminder 4

  const nextReminder = nextReminderDays
    ? new Date(now.getTime() + nextReminderDays * 24 * 60 * 60 * 1000)
    : null;

  // Log reminder
  await supabase.from('invoice_reminders').insert({
    invoice_id: invoice.id,
    contractor_id: invoice.contractor_id,
    reminder_number: reminderNum,
    tone,
    channel: customerPhone ? 'sms' : 'email',
    message_body: message.sms,
    sent_at: now.toISOString(),
    delivered: true,
  });

  // Update invoice
  await supabase.from('invoices').update({
    status: 'overdue',
    reminder_count: reminderNum,
    last_reminder_sent_at: now.toISOString(),
    next_reminder_at: nextReminder?.toISOString() || null,
  }).eq('id', invoice.id);

  // Alert contractor on escalation (reminder 3+)
  if (reminderNum >= 3 && invoice.contractors.owner_phone) {
    const contractorAlert = `⚠️ CrewBox Alert: Invoice ${invoice.invoice_number} for $${invoice.amount_due} is now ${daysOverdue} days overdue from ${invoice.customers?.name || 'customer'}. Final reminder sent. View: ${process.env.APP_URL}/invoices/${invoice.id}`;
    await twilioClient.messages.create({
      to: invoice.contractors.owner_phone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: contractorAlert,
    });
  }

  // Log activity
  await supabase.from('activity_log').insert({
    contractor_id: invoice.contractor_id,
    agent: 'collector',
    action: 'reminder_sent',
    entity_type: 'invoice',
    entity_id: invoice.id,
    description: `Reminder #${reminderNum} (${tone}) sent for ${invoice.invoice_number} — $${invoice.amount_due} overdue ${daysOverdue} days`,
    amount: invoice.amount_due,
  });
}

// ============================================================
// PART 3: AI-GENERATED COLLECTION MESSAGES
// Claude writes a natural, personalized message per invoice
// ============================================================

async function generateCollectionMessage({
  businessName, ownerName, customerName, invoiceNumber,
  amountDue, daysOverdue, reminderNum, tone, paymentLink, jobDescription,
}) {
  const prompt = `You are writing a payment reminder SMS for ${businessName}.

Context:
- Customer name: ${customerName || 'the customer'}
- Invoice: ${invoiceNumber}
- Amount due: $${amountDue}
- Days overdue: ${daysOverdue}
- This is reminder #${reminderNum}
- Tone required: ${tone}
- Payment link: ${paymentLink || '[payment link]'}
- Job was: ${jobDescription || 'services rendered'}

Tone guidelines:
- friendly: Warm, helpful, assumes good faith. Maybe they forgot.
- firm: Professional, clear expectation, sense of urgency without being rude.
- final: Direct, serious tone. Makes clear this is the last automated message before further action.

Write a SINGLE SMS message that:
1. Is under 160 characters if possible (max 320)
2. Includes the payment link
3. Sounds like a real person, not a bot
4. Matches the tone exactly
5. Never threatens legal action directly — just says "further steps" for final

Return ONLY the SMS text. No quotes, no explanation, no formatting.`;

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const smsText = response.content[0].text.trim();

  return { sms: smsText };
}

// ============================================================
// PART 4: MARK NEWLY OVERDUE INVOICES
// ============================================================

async function markNewlyOverdueInvoices(now) {
  const today = now.toISOString().split('T')[0];
  await supabase
    .from('invoices')
    .update({ status: 'overdue' })
    .eq('status', 'sent')
    .lte('due_date', today);
}

// ============================================================
// PART 5: CREATE INVOICE MANUALLY
// Called when contractor completes a job
// ============================================================

export async function createInvoiceFromJob(jobId, contractorId, options = {}) {
  const { data: job } = await supabase
    .from('jobs')
    .select('*, customers(*), quotes(line_items, total_amount, subtotal, tax_amount)')
    .eq('id', jobId)
    .single();

  if (!job) throw new Error('Job not found');

  // Use quote data if available, otherwise use job data
  const quote = job.quotes?.[0];
  const { count } = await supabase
    .from('invoices')
    .select('id', { count: 'exact' })
    .eq('contractor_id', contractorId);

  const invoiceNumber = `INV-${new Date().getFullYear()}-${String((count || 0) + 1).padStart(4, '0')}`;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (options.paymentTermsDays || 30));

  const { data: invoice } = await supabase
    .from('invoices')
    .insert({
      contractor_id: contractorId,
      job_id: jobId,
      customer_id: job.customer_id,
      invoice_number: invoiceNumber,
      title: `Services: ${job.title}`,
      line_items: quote?.line_items || [
        { description: job.title, qty: 1, unit_price: job.final_amount || 0, total: job.final_amount || 0 }
      ],
      subtotal: quote?.subtotal || job.final_amount || 0,
      tax_amount: quote?.tax_amount || 0,
      total_amount: quote?.total_amount || job.final_amount || 0,
      status: 'draft',
      due_date: dueDate.toISOString().split('T')[0],
      payment_terms_days: options.paymentTermsDays || 30,
    })
    .select()
    .single();

  // Update job status
  await supabase.from('jobs')
    .update({ status: 'completed' })
    .eq('id', jobId);

  // Auto-send if enabled
  if (options.autoSend !== false) {
    const { paymentLinkUrl } = await createInvoicePaymentLink(invoice.id);

    if (job.customers?.phone) {
      const msg = `Hi ${job.customers.name || 'there'}! Your invoice from ${job.contractors?.business_name || 'us'} is ready — $${invoice.total_amount}. Pay securely: ${paymentLinkUrl} — Due ${dueDate.toLocaleDateString()}. Thank you!`;
      await twilioClient.messages.create({
        to: job.customers.phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: msg,
      });
    }

    await supabase.from('invoices').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      stripe_payment_link_url: paymentLinkUrl,
      next_reminder_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('id', invoice.id);
  }

  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'collector',
    action: 'invoice_created',
    entity_type: 'invoice',
    entity_id: invoice.id,
    description: `Invoice ${invoiceNumber} created for ${job.customers?.name || 'customer'} — $${invoice.total_amount}`,
    amount: invoice.total_amount,
  });

  return { invoiceId: invoice.id, invoiceNumber, amount: invoice.total_amount };
}

// ============================================================
// PART 6: COLLECTION ANALYTICS
// ============================================================

export async function getCollectionStats(contractorId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [paid, outstanding, reminders] = await Promise.all([
    supabase.from('payments')
      .select('amount')
      .eq('contractor_id', contractorId)
      .eq('status', 'succeeded')
      .gte('paid_at', since.toISOString()),
    supabase.from('invoices')
      .select('amount_due, status, reminder_count')
      .eq('contractor_id', contractorId)
      .in('status', ['sent', 'overdue']),
    supabase.from('invoice_reminders')
      .select('tone, payment_triggered')
      .eq('contractor_id', contractorId)
      .gte('sent_at', since.toISOString()),
  ]);

  const totalCollected = paid.data?.reduce((s, p) => s + Number(p.amount), 0) || 0;
  const totalOutstanding = outstanding.data?.reduce((s, i) => s + Number(i.amount_due), 0) || 0;
  const overdueCount = outstanding.data?.filter(i => i.status === 'overdue').length || 0;

  return {
    totalCollected,
    totalOutstanding,
    overdueCount,
    remindersSet: reminders.data?.length || 0,
    period: `Last ${days} days`,
  };
}
