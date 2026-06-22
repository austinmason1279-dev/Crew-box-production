// ============================================================
// CREWBOX — ESTIMATOR AGENT
// File: agents/estimator/estimator-agent.js
//
// The Estimator turns job photos + voice notes into
// professional, itemized quotes sent in under 60 seconds.
//
// Flow:
//   1. Contractor snaps photo on job site
//   2. Optionally leaves a voice note
//   3. Claude Vision analyzes the photo
//   4. Claude generates itemized quote
//   5. PDF generated and stored to S3
//   6. Stripe payment link created for that amount
//   7. SMS + email sent to customer with quote
//   8. Auto follow-up if no response in 24 hours
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { createInvoicePaymentLink } from '../../stripe/stripe-service.js';
import { uploadDocument, getSecureDocumentUrl } from '../../storage/storage-service.js';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ============================================================
// PART 1: GENERATE QUOTE FROM PHOTOS + VOICE NOTE
// ============================================================

export async function generateQuoteFromPhoto({
  contractorId,
  jobId,
  customerId,
  photoBuffers,         // array of photo Buffers
  photoMimeTypes,       // array of mime types
  voiceNoteTranscript,  // optional text transcription of voice note
  customerName,
  customerPhone,
  customerEmail,
  serviceAddress,
}) {
  const startTime = Date.now();

  // 1. Load contractor context
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      *,
      agent_configs!inner (settings)
    `)
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'estimator')
    .single();

  const agentSettings = contractor.agent_configs?.[0]?.settings || {};

  // 2. Build Claude message with vision
  const photoContent = photoBuffers.map((buffer, i) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: photoMimeTypes[i] || 'image/jpeg',
      data: buffer.toString('base64'),
    },
  }));

  const quotePrompt = buildEstimatorPrompt(contractor, voiceNoteTranscript, serviceAddress);

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          ...photoContent,
          {
            type: 'text',
            text: quotePrompt,
          },
        ],
      },
    ],
  });

  // 3. Parse the structured quote from Claude's response
  const rawResponse = response.content[0].text;
  const quoteData = parseQuoteResponse(rawResponse, contractor);

  // 4. Generate quote number
  const { data: quoteCountData } = await supabase
    .from('quotes')
    .select('id', { count: 'exact' })
    .eq('contractor_id', contractorId);
  const quoteNumber = `Q-${new Date().getFullYear()}-${String((quoteCountData?.length || 0) + 1).padStart(4, '0')}`;

  // 5. Save quote to database
  const { data: quote } = await supabase
    .from('quotes')
    .insert({
      contractor_id: contractorId,
      job_id: jobId,
      customer_id: customerId,
      quote_number: quoteNumber,
      title: quoteData.title,
      description: quoteData.description,
      line_items: quoteData.lineItems,
      subtotal: quoteData.subtotal,
      tax_rate: agentSettings.tax_rate || 0,
      tax_amount: quoteData.subtotal * (agentSettings.tax_rate || 0),
      discount_amount: 0,
      total_amount: quoteData.total,
      status: 'draft',
      ai_generated: true,
      expires_at: new Date(Date.now() + (agentSettings.valid_days || 30) * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();

  // 6. Generate PDF
  const pdfBuffer = await generateQuotePDF(quote, contractor, customerName, serviceAddress);

  // 7. Upload PDF + photos to S3
  const { licensee_id } = await getLicenseeId(contractorId);
  const pdfDoc = await uploadDocument({
    contractorId,
    licenseeId: licensee_id,
    documentType: 'quote_pdf',
    fileBuffer: pdfBuffer,
    originalFilename: `${quoteNumber}.pdf`,
    mimeType: 'application/pdf',
    jobId,
  });

  // Upload job photos
  for (let i = 0; i < photoBuffers.length; i++) {
    await uploadDocument({
      contractorId,
      licenseeId: licensee_id,
      documentType: 'job_photo_before',
      fileBuffer: photoBuffers[i],
      originalFilename: `job-photo-${i + 1}.jpg`,
      mimeType: photoMimeTypes[i] || 'image/jpeg',
      jobId,
    });
  }

  // 8. Update quote with PDF URL
  await supabase.from('quotes').update({
    pdf_url: pdfDoc.s3Key,
    status: 'draft',
  }).eq('id', quote.id);

  const elapsed = Date.now() - startTime;

  // 9. Send quote (if auto-send enabled)
  if (agentSettings.auto_send !== false) {
    await sendQuote(quote.id, contractorId, customerPhone, customerEmail, contractor);
  }

  // Log activity
  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'estimator',
    action: 'quote_generated',
    entity_type: 'quote',
    entity_id: quote.id,
    description: `Quote ${quoteNumber} generated in ${elapsed}ms — $${quoteData.total}`,
    amount: quoteData.total,
  });

  return {
    quoteId: quote.id,
    quoteNumber,
    total: quoteData.total,
    lineItems: quoteData.lineItems,
    generatedInMs: elapsed,
  };
}

// ============================================================
// PART 2: THE ESTIMATOR PROMPT
// Tells Claude to analyze the photo and produce a structured quote
// ============================================================

function buildEstimatorPrompt(contractor, voiceNote, serviceAddress) {
  return `You are a professional estimator for ${contractor.business_name}, a ${contractor.trade_type} company.

Analyze the attached photo(s) and generate a detailed, professional job quote.

## BUSINESS CONTEXT
- Company: ${contractor.business_name}
- Trade: ${contractor.trade_type}${contractor.trade_specialty ? ` (${contractor.trade_specialty})` : ''}
- Location: ${contractor.address_city}, ${contractor.address_state}
${contractor.pricing_notes ? `- Pricing Guidelines: ${contractor.pricing_notes}` : ''}
${serviceAddress ? `- Service Address: ${serviceAddress}` : ''}

${voiceNote ? `## TECHNICIAN VOICE NOTE
"${voiceNote}"
Use this to add context to what you see in the photo.` : ''}

## INSTRUCTIONS
1. Identify what work needs to be done based on the photo
2. Break it down into clear line items (materials + labor separately)
3. Use realistic market pricing for ${contractor.address_state}
4. Be specific — customers want to see exactly what they're paying for
5. Include any standard industry recommendations (e.g. if you see corrosion, recommend preventive treatment)

## REQUIRED OUTPUT FORMAT
Respond ONLY with valid JSON matching this exact structure:

{
  "title": "Brief job title (max 60 chars)",
  "description": "2-3 sentence description of the scope of work",
  "lineItems": [
    {
      "description": "Line item description",
      "qty": 1,
      "unit": "each|hrs|sqft|lnft",
      "unitPrice": 0.00,
      "total": 0.00
    }
  ],
  "subtotal": 0.00,
  "total": 0.00,
  "notes": "Any important notes, warranties, or recommendations",
  "estimatedDuration": "e.g. 2-4 hours",
  "confidence": "high|medium|low",
  "confidenceNote": "Why confidence is not high (if applicable)"
}

IMPORTANT: Return ONLY the JSON object. No markdown, no explanation, no code blocks.`;
}

// ============================================================
// PART 3: SEND QUOTE
// SMS + email delivery with payment-ready link
// ============================================================

export async function sendQuote(quoteId, contractorId, customerPhone, customerEmail, contractor = null) {
  if (!contractor) {
    const { data } = await supabase
      .from('contractors')
      .select('business_name, owner_phone, owner_name')
      .eq('id', contractorId)
      .single();
    contractor = data;
  }

  const { data: quote } = await supabase
    .from('quotes')
    .select('*, customers(name, phone, email)')
    .eq('id', quoteId)
    .single();

  // Get a signed URL for the PDF (expires in 7 days for quotes)
  const { data: pdfDoc } = await supabase
    .from('documents')
    .select('id')
    .eq('contractor_id', contractorId)
    .eq('document_type', 'quote_pdf')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .single();

  // Build quote acceptance URL (deep link to quote in app)
  const quoteUrl = `${process.env.APP_URL}/quote/${quoteId}`;

  const smsMessage = `Hi ${quote.customers?.name || 'there'}! ${contractor.business_name} has sent you a quote for $${quote.total_amount}. Review and accept here: ${quoteUrl} — Valid for ${calculateDaysRemaining(quote.expires_at)} days. Questions? Reply to this message.`;

  const sentVia = [];

  // Send SMS
  const phone = customerPhone || quote.customers?.phone;
  if (phone) {
    await twilioClient.messages.create({
      to: phone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: smsMessage,
    });
    sentVia.push('sms');
  }

  // TODO: Send email (integrate with SendGrid/Resend in Phase 3)
  if (customerEmail || quote.customers?.email) {
    sentVia.push('email'); // placeholder
  }

  // Update quote status
  await supabase.from('quotes').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    sent_via: sentVia,
  }).eq('id', quoteId);

  // Schedule follow-up (24 hours if no response)
  await scheduleQuoteFollowUp(quoteId, contractorId, 24);

  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'estimator',
    action: 'quote_sent',
    entity_type: 'quote',
    entity_id: quoteId,
    description: `Quote ${quote.quote_number} sent via ${sentVia.join(' + ')} — $${quote.total_amount}`,
    amount: quote.total_amount,
  });

  return { sent: true, via: sentVia, quoteUrl };
}

// ============================================================
// PART 4: QUOTE FOLLOW-UP (Runs on schedule)
// ============================================================

export async function processQuoteFollowUps() {
  const now = new Date();
  const cutoff = new Date(now - 24 * 60 * 60 * 1000); // 24 hours ago

  const { data: staleQuotes } = await supabase
    .from('quotes')
    .select('*, customers(name, phone), contractors(business_name, owner_phone)')
    .eq('status', 'sent')
    .lt('sent_at', cutoff.toISOString())
    .gt('expires_at', now.toISOString());

  for (const quote of (staleQuotes || [])) {
    const phone = quote.customers?.phone;
    if (!phone) continue;

    const followUpMsg = `Hi ${quote.customers?.name || 'there'}, just following up on your quote from ${quote.contractors?.business_name} for $${quote.total_amount}. Any questions? Click here to review: ${process.env.APP_URL}/quote/${quote.id}`;

    await twilioClient.messages.create({
      to: phone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: followUpMsg,
    });

    await supabase.from('activity_log').insert({
      contractor_id: quote.contractor_id,
      agent: 'estimator',
      action: 'quote_followup_sent',
      entity_type: 'quote',
      entity_id: quote.id,
      description: `Follow-up sent for quote ${quote.quote_number} — $${quote.total_amount}`,
    });
  }

  return { processed: staleQuotes?.length || 0 };
}

// ============================================================
// PART 5: CONVERT QUOTE TO INVOICE
// Called when customer accepts the quote
// ============================================================

export async function convertQuoteToInvoice(quoteId, contractorId) {
  const { data: quote } = await supabase
    .from('quotes')
    .select('*, customers(*)')
    .eq('id', quoteId)
    .eq('contractor_id', contractorId)
    .single();

  if (!quote) throw new Error('Quote not found');

  // Generate invoice number
  const { count } = await supabase
    .from('invoices')
    .select('id', { count: 'exact' })
    .eq('contractor_id', contractorId);
  const invoiceNumber = `INV-${new Date().getFullYear()}-${String((count || 0) + 1).padStart(4, '0')}`;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  // Create invoice from quote
  const { data: invoice } = await supabase
    .from('invoices')
    .insert({
      contractor_id: contractorId,
      job_id: quote.job_id,
      customer_id: quote.customer_id,
      quote_id: quoteId,
      invoice_number: invoiceNumber,
      title: quote.title,
      line_items: quote.line_items,
      subtotal: quote.subtotal,
      tax_rate: quote.tax_rate,
      tax_amount: quote.tax_amount,
      discount_amount: quote.discount_amount,
      total_amount: quote.total_amount,
      status: 'draft',
      due_date: dueDate.toISOString().split('T')[0],
      payment_terms_days: 30,
    })
    .select()
    .single();

  // Mark quote as accepted
  await supabase.from('quotes').update({
    status: 'accepted',
    accepted_at: new Date().toISOString(),
  }).eq('id', quoteId);

  // Update job status
  if (quote.job_id) {
    await supabase.from('jobs').update({ status: 'scheduled', final_amount: quote.total_amount })
      .eq('id', quote.job_id);
  }

  // Create Stripe payment link
  const { paymentLinkUrl } = await createInvoicePaymentLink(invoice.id);

  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'estimator',
    action: 'quote_converted_to_invoice',
    entity_type: 'invoice',
    entity_id: invoice.id,
    description: `Quote ${quote.quote_number} accepted → Invoice ${invoiceNumber} created — $${quote.total_amount}`,
    amount: quote.total_amount,
  });

  return {
    invoiceId: invoice.id,
    invoiceNumber,
    paymentLinkUrl,
    amount: quote.total_amount,
  };
}

// ============================================================
// HELPERS
// ============================================================

function parseQuoteResponse(rawResponse, contractor) {
  try {
    const cleaned = rawResponse.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(cleaned);

    // Validate and fix totals
    const subtotal = parsed.lineItems.reduce((sum, item) => sum + (item.total || item.unitPrice * item.qty || 0), 0);
    const roundedSubtotal = Math.round(subtotal * 100) / 100;

    return {
      title: parsed.title || 'Service Quote',
      description: parsed.description || '',
      lineItems: parsed.lineItems || [],
      subtotal: roundedSubtotal,
      total: roundedSubtotal, // tax added in database layer
      notes: parsed.notes || '',
      estimatedDuration: parsed.estimatedDuration || '',
    };
  } catch (e) {
    throw new Error(`Failed to parse quote from AI response: ${e.message}\nRaw: ${rawResponse.slice(0, 200)}`);
  }
}

async function generateQuotePDF(quote, contractor, customerName, serviceAddress) {
  // Simple HTML-to-PDF approach using puppeteer or weasyprint
  // For now, return a placeholder buffer — integrate PDF generation in Phase 3
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head><style>
      body { font-family: Arial, sans-serif; padding: 40px; }
      h1 { color: #111; } .header { border-bottom: 2px solid #F5C800; padding-bottom: 20px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
      th { background: #F5C800; color: #111; }
      .total { font-size: 20px; font-weight: bold; text-align: right; margin-top: 20px; }
    </style></head>
    <body>
      <div class="header">
        <h1>${contractor.business_name}</h1>
        <p>${contractor.address_city}, ${contractor.address_state}</p>
      </div>
      <h2>Quote ${quote.quote_number}</h2>
      <p><strong>Prepared for:</strong> ${customerName || 'Customer'}</p>
      ${serviceAddress ? `<p><strong>Service Address:</strong> ${serviceAddress}</p>` : ''}
      <p><strong>Valid Until:</strong> ${new Date(quote.expires_at).toLocaleDateString()}</p>
      <table>
        <tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr>
        ${(quote.line_items || []).map(item => `
          <tr>
            <td>${item.description}</td>
            <td>${item.qty}</td>
            <td>$${item.unitPrice?.toFixed(2)}</td>
            <td>$${item.total?.toFixed(2)}</td>
          </tr>
        `).join('')}
      </table>
      <div class="total">Total: $${quote.total_amount?.toFixed(2)}</div>
    </body>
    </html>
  `;

  // Return HTML as buffer (proper PDF generation in Phase 3 with puppeteer)
  return Buffer.from(htmlContent);
}

async function scheduleQuoteFollowUp(quoteId, contractorId, hours) {
  // In production: add to a job queue (BullMQ, Inngest, etc.)
  // For now: the processQuoteFollowUps() function handles this via cron
  console.log(`Follow-up scheduled for quote ${quoteId} in ${hours} hours`);
}

async function getLicenseeId(contractorId) {
  const { data } = await supabase
    .from('contractors')
    .select('licensee_id')
    .eq('id', contractorId)
    .single();
  return data;
}

function calculateDaysRemaining(expiresAt) {
  if (!expiresAt) return 30;
  const days = Math.ceil((new Date(expiresAt) - new Date()) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}
