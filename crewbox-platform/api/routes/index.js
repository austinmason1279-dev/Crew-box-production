// ============================================================
// CREWBOX — API ROUTES & WEBHOOK HANDLERS
// File: api/routes/index.js
//
// All incoming webhooks and API endpoints:
//   POST /api/webhooks/vapi/call-ended        ← Vapi fires when call ends
//   POST /api/webhooks/vapi/inbound           ← Twilio routes call to Vapi
//   POST /api/webhooks/stripe                 ← Stripe payment events
//   POST /api/vapi/tools/book-appointment     ← AI tool during live call
//   POST /api/vapi/tools/transfer-call        ← AI transfers to owner
//   POST /api/vapi/tools/check-service-area   ← AI checks coverage
//   POST /api/contractors/onboard             ← New contractor setup
//   POST /api/quotes/generate                 ← Trigger quote from photo
//   POST /api/quotes/:id/send                 ← Send quote to customer
//   POST /api/quotes/:id/accept               ← Customer accepts quote
//   GET  /api/contractors/:id/dashboard       ← Contractor dashboard data
//   GET  /api/licensees/:id/dashboard         ← Licensee dashboard KPIs
// ============================================================

import express from 'express';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import {
  handleCallEnded,
  handleBookAppointment,
  handleTransferCall,
  handleCheckServiceArea,
  createReceptionistAssistant,
  provisionContractorNumber,
  getCallAnalytics,
} from '../../vapi/vapi-service.js';
import {
  generateQuoteFromPhoto,
  sendQuote,
  convertQuoteToInvoice,
  processQuoteFollowUps,
} from '../../agents/estimator/estimator-agent.js';
import {
  handleStripeWebhook,
  createContractorConnectedAccount,
  getContractorOnboardingLink,
  checkContractorOnboardingStatus,
  sendInvoiceReminders,
  getContractorFinancialSummary,
} from '../../stripe/stripe-service.js';
import { requireAuth, requireLicensee, updateOnboardingStep, getOnboardingStatus } from '../../auth/auth-service.js';
import { listContractorDocuments, checkExpiringDocuments } from '../../storage/storage-service.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ============================================================
// VAPI WEBHOOKS
// ============================================================

/**
 * POST /api/webhooks/vapi/call-ended
 * Vapi fires this when a call completes
 * Saves transcript, notifies contractor, sends customer SMS
 */
router.post('/webhooks/vapi/call-ended', async (req, res) => {
  try {
    // Verify webhook secret
    const secret = req.headers['x-vapi-secret'];
    if (secret !== process.env.VAPI_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await handleCallEnded(req.body);
    res.json(result);
  } catch (err) {
    console.error('call-ended webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/vapi/inbound
 * Twilio routes inbound calls here
 * We tell Twilio to forward to the correct Vapi assistant
 */
router.post('/webhooks/vapi/inbound', async (req, res) => {
  try {
    const { To: toNumber, From: fromNumber, CallSid } = req.body;

    // Find which contractor owns this Vapi number
    const { data: contractor } = await supabase
      .from('contractors')
      .select('id, business_name, vapi_phone_number_id, agent_configs!inner(vapi_assistant_id)')
      .eq('ai_phone_number', toNumber)
      .eq('agent_configs.agent_type', 'receptionist')
      .eq('is_active', true)
      .single();

    if (!contractor) {
      // No contractor found — return TwiML that says sorry
      return res.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response><Say>We're sorry, this number is not currently active. Goodbye.</Say></Response>
      `);
    }

    // Pre-create a call record so we can track it from the start
    await supabase.from('calls').insert({
      contractor_id: contractor.id,
      caller_phone: fromNumber,
      direction: 'inbound',
      started_at: new Date().toISOString(),
    });

    // TwiML to connect to Vapi SIP
    const vapiSipUri = `sip:${toNumber}@${contractor.vapi_phone_number_id}.sip.vapi.ai`;

    res.type('text/xml').send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Dial>
          <Sip>${vapiSipUri}</Sip>
        </Dial>
      </Response>
    `);
  } catch (err) {
    console.error('inbound webhook error:', err);
    res.status(500).send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response><Say>We're experiencing technical difficulties. Please try again later.</Say></Response>
    `);
  }
});

// ============================================================
// VAPI TOOL HANDLERS (called by AI DURING live calls)
// ============================================================

/**
 * POST /api/vapi/tools/book-appointment
 * The AI calls this to actually book the job in the database
 */
router.post('/vapi/tools/book-appointment', async (req, res) => {
  try {
    const { toolCallId, toolCallList, call } = req.body;
    const contractorId = call.metadata?.contractor_id;
    const args = toolCallList?.[0]?.function?.arguments || req.body;

    const result = await handleBookAppointment(
      contractorId,
      typeof args === 'string' ? JSON.parse(args) : args,
      call.id
    );

    // Vapi expects this response format for tool calls
    res.json({
      results: [{
        toolCallId,
        result: result.message,
      }],
    });
  } catch (err) {
    res.json({
      results: [{
        toolCallId: req.body.toolCallId,
        result: 'I was unable to complete the booking. I will make sure someone follows up with you directly.',
      }],
    });
  }
});

/**
 * POST /api/vapi/tools/transfer-call
 * AI calls this to transfer to the business owner
 */
router.post('/vapi/tools/transfer-call', async (req, res) => {
  try {
    const contractorId = req.body.call?.metadata?.contractor_id;
    const { reason } = req.body.toolCallList?.[0]?.function?.arguments || {};

    const result = await handleTransferCall(contractorId, reason);

    res.json({
      results: [{
        toolCallId: req.body.toolCallId,
        result: result.message,
      }],
      // Vapi transfer instruction
      phoneNumberId: result.phoneNumber,
    });
  } catch (err) {
    res.json({
      results: [{ toolCallId: req.body.toolCallId, result: 'Transfer failed. Let me take your details instead.' }],
    });
  }
});

/**
 * POST /api/vapi/tools/check-service-area
 */
router.post('/vapi/tools/check-service-area', async (req, res) => {
  try {
    const contractorId = req.body.call?.metadata?.contractor_id;
    const { zip_code } = req.body.toolCallList?.[0]?.function?.arguments || {};

    const result = await handleCheckServiceArea(contractorId, zip_code);

    res.json({
      results: [{ toolCallId: req.body.toolCallId, result: result.message }],
    });
  } catch (err) {
    res.json({ results: [{ toolCallId: req.body.toolCallId, result: 'Let me check on that for you.' }] });
  }
});

// ============================================================
// STRIPE WEBHOOK
// ============================================================

/**
 * POST /api/webhooks/stripe
 * Stripe fires this for all payment events
 * MUST use raw body — Stripe signature verification requires it
 */
router.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.headers['stripe-signature'];
      const result = await handleStripeWebhook(req.body, signature);
      res.json(result);
    } catch (err) {
      console.error('Stripe webhook error:', err);
      res.status(400).json({ error: err.message });
    }
  }
);

// ============================================================
// CONTRACTOR ONBOARDING API
// ============================================================

/**
 * POST /api/contractors/onboard
 * Licensee onboards a new contractor (3-minute flow)
 */
router.post('/contractors/onboard', async (req, res) => {
  try {
    const user = await requireLicensee(req);
    const {
      businessName, ownerName, ownerEmail, ownerPhone,
      tradeType, addressCity, addressState,
      existingPhoneNumber, preferredAreaCode,
      agentsToActivate = ['receptionist', 'estimator', 'collector', 'marketer', 'rep'],
    } = req.body;

    // 1. Create contractor in DB
    const { data: contractor, error } = await supabase
      .from('contractors')
      .insert({
        licensee_id: user.licenseeId,
        business_name: businessName,
        owner_name: ownerName,
        owner_email: ownerEmail,
        owner_phone: ownerPhone,
        trade_type: tradeType,
        address_city: addressCity,
        address_state: addressState,
        existing_phone_number: existingPhoneNumber,
        onboarding_step: 1,
      })
      .select()
      .single();

    if (error) throw error;

    // 2. Create agent configs for requested agents
    await supabase.from('agent_configs').insert(
      agentsToActivate.map(type => ({
        contractor_id: contractor.id,
        agent_type: type,
        status: 'configuring',
      }))
    );

    // 3. Provision AI phone number
    const phoneSetup = await provisionContractorNumber(contractor.id, preferredAreaCode);

    // 4. Create Vapi receptionist assistant
    const assistantSetup = await createReceptionistAssistant(contractor.id);

    // 5. Create Stripe Connected Account
    const stripeAccountId = await createContractorConnectedAccount(contractor.id);
    const stripeOnboardingUrl = await getContractorOnboardingLink(
      contractor.id,
      `${process.env.APP_URL}/contractors/${contractor.id}/setup`
    );

    // 6. Update onboarding step
    await updateOnboardingStep(contractor.id, 2);

    // 7. Send welcome SMS to contractor
    const twilio = (await import('twilio')).default;
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilioClient.messages.create({
      to: ownerPhone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `Welcome to CrewBox, ${ownerName}! 🎉 Your AI business assistant is being set up for ${businessName}. AI number: ${phoneSetup.aiPhoneNumber}. Dashboard: ${process.env.APP_URL}/my-business`,
    });

    res.json({
      contractorId: contractor.id,
      aiPhoneNumber: phoneSetup.aiPhoneNumber,
      stripeOnboardingUrl,
      callForwardInstructions: buildCallForwardInstructions(existingPhoneNumber, phoneSetup.aiPhoneNumber),
      nextStep: 'contractor_connects_bank',
    });

  } catch (err) {
    console.error('Onboarding error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/contractors/:id/onboarding-status
 */
router.get('/contractors/:id/onboarding-status', async (req, res) => {
  try {
    const user = await requireAuth(req);
    const status = await getOnboardingStatus(req.params.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUOTE ENDPOINTS
// ============================================================

/**
 * POST /api/quotes/generate
 * Contractor uploads photos → AI generates quote
 */
router.post('/quotes/generate',
  upload.array('photos', 10),
  async (req, res) => {
    try {
      const user = await requireAuth(req, ['platform_admin', 'licensee', 'contractor']);
      const {
        contractorId, jobId, customerId,
        customerName, customerPhone, customerEmail,
        serviceAddress, voiceNoteTranscript,
      } = req.body;

      const photos = req.files || [];
      if (!photos.length) return res.status(400).json({ error: 'At least one photo required' });

      const result = await generateQuoteFromPhoto({
        contractorId,
        jobId: jobId || null,
        customerId: customerId || null,
        photoBuffers: photos.map(f => f.buffer),
        photoMimeTypes: photos.map(f => f.mimetype),
        voiceNoteTranscript: voiceNoteTranscript || null,
        customerName,
        customerPhone,
        customerEmail,
        serviceAddress,
      });

      res.json(result);
    } catch (err) {
      console.error('Quote generation error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/quotes/:id/send
 * Send a quote to the customer
 */
router.post('/quotes/:id/send', async (req, res) => {
  try {
    const user = await requireAuth(req);
    const { customerPhone, customerEmail } = req.body;

    const { data: quote } = await supabase.from('quotes').select('contractor_id').eq('id', req.params.id).single();
    const result = await sendQuote(req.params.id, quote.contractor_id, customerPhone, customerEmail);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/quotes/:id/accept
 * Customer accepts → creates invoice + payment link
 */
router.post('/quotes/:id/accept', async (req, res) => {
  try {
    // This endpoint can be accessed without auth (customer clicks link in SMS)
    const { data: quote } = await supabase
      .from('quotes')
      .select('contractor_id, status')
      .eq('id', req.params.id)
      .single();

    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    if (quote.status === 'accepted') return res.json({ message: 'Already accepted' });

    const result = await convertQuoteToInvoice(req.params.id, quote.contractor_id);

    // Mark quote viewed timestamp
    await supabase.from('quotes').update({ viewed_at: new Date().toISOString() }).eq('id', req.params.id);

    res.json({
      message: 'Quote accepted! Your invoice has been created.',
      invoiceId: result.invoiceId,
      paymentLinkUrl: result.paymentLinkUrl,
      amount: result.amount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DASHBOARD DATA ENDPOINTS
// ============================================================

/**
 * GET /api/contractors/:id/dashboard
 * Full contractor dashboard data
 */
router.get('/contractors/:id/dashboard', async (req, res) => {
  try {
    const user = await requireAuth(req);
    const contractorId = req.params.id;

    const [
      financial,
      callAnalytics,
      recentCalls,
      openInvoices,
      recentJobs,
      agentStatuses,
    ] = await Promise.all([
      getContractorFinancialSummary(contractorId),
      getCallAnalytics(contractorId, 30),
      supabase.from('calls').select('caller_name, caller_phone, outcome, appointment_booked, summary, started_at')
        .eq('contractor_id', contractorId).order('started_at', { ascending: false }).limit(10),
      supabase.from('invoices').select('invoice_number, total_amount, amount_due, status, due_date, customers(name)')
        .eq('contractor_id', contractorId).in('status', ['sent', 'overdue']).order('due_date'),
      supabase.from('jobs').select('title, status, scheduled_start, customers(name)')
        .eq('contractor_id', contractorId).order('created_at', { ascending: false }).limit(5),
      supabase.from('agent_configs').select('agent_type, status, last_active_at')
        .eq('contractor_id', contractorId),
    ]);

    res.json({
      financial,
      calls: callAnalytics,
      recentCalls: recentCalls.data || [],
      openInvoices: openInvoices.data || [],
      recentJobs: recentJobs.data || [],
      agents: agentStatuses.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/licensees/:id/dashboard
 * Full licensee partner dashboard
 */
router.get('/licensees/:id/dashboard', async (req, res) => {
  try {
    const user = await requireLicensee(req);
    const licenseeId = req.params.id;

    const [stats, recentActivity, contractors] = await Promise.all([
      supabase.from('licensee_dashboard_stats').select('*').eq('licensee_id', licenseeId).single(),
      supabase.from('activity_log')
        .select('agent, action, description, amount, created_at, entity_type')
        .in('contractor_id',
          supabase.from('contractors').select('id').eq('licensee_id', licenseeId)
        )
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('contractors')
        .select('id, business_name, trade_type, address_city, is_active, onboarding_complete, created_at')
        .eq('licensee_id', licenseeId)
        .order('created_at', { ascending: false }),
    ]);

    res.json({
      stats: stats.data,
      recentActivity: recentActivity.data || [],
      contractors: contractors.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SCHEDULED JOB ENDPOINTS (called by cron)
// ============================================================

/**
 * POST /api/cron/send-reminders
 * Collector agent — runs daily at 8am
 */
router.post('/cron/send-reminders', async (req, res) => {
  try {
    const cronSecret = req.headers['x-cron-secret'];
    if (cronSecret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const results = await sendInvoiceReminders();
    res.json({ sent: results.length, details: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cron/quote-followups
 * Estimator agent follow-ups — runs daily at 9am
 */
router.post('/cron/quote-followups', async (req, res) => {
  try {
    const cronSecret = req.headers['x-cron-secret'];
    if (cronSecret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const results = await processQuoteFollowUps();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cron/expiring-documents
 * Check for expiring licenses/insurance — runs weekly
 */
router.post('/cron/expiring-documents', async (req, res) => {
  try {
    const cronSecret = req.headers['x-cron-secret'];
    if (cronSecret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const alerts = await checkExpiringDocuments(30);
    // TODO: Send alerts to licensees for their contractors
    res.json({ alerts: alerts.length, details: alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPER
// ============================================================

function buildCallForwardInstructions(existingNumber, aiNumber) {
  return {
    summary: `Forward ${existingNumber} to ${aiNumber}`,
    steps: {
      att: `Dial *21*${aiNumber}# from your phone to set up forwarding when you don't answer`,
      verizon: `Go to Settings → Phone → Call Forwarding → enter ${aiNumber}`,
      tmobile: `Dial **004*${aiNumber}# to forward when unanswered`,
      general: `Call your carrier and say: "I'd like to set up conditional call forwarding when I don't answer to ${aiNumber}"`,
    },
    note: `Your existing number ${existingNumber} stays exactly the same. Customers call your existing number as always.`,
  };
}

export default router;
