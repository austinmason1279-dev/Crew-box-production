// ============================================================
// CREWBOX — VAPI VOICE AGENT SERVICE
// File: vapi/vapi-service.js
//
// The Receptionist Agent — answers every call for every contractor
// 
// Flow:
//   1. Customer calls contractor's existing number
//   2. Call forwards to contractor's CrewBox AI number
//   3. Vapi picks up, loads contractor's business knowledge
//   4. AI has full conversation: qualifies lead, books job
//   5. On end: transcript saved, job created, SMS confirmation sent
//   6. Contractor gets instant text summary
// ============================================================

import Vapi from '@vapi-ai/server-sdk';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const vapi = new Vapi({ token: process.env.VAPI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================================
// PART 1: PROVISION A PHONE NUMBER FOR A CONTRACTOR
// Called during contractor onboarding (Step 2)
// ============================================================

export async function provisionContractorNumber(contractorId, preferredAreaCode = null) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('business_name, address_state, address_city, existing_phone_number')
    .eq('id', contractorId)
    .single();

  // Buy a Twilio number in the contractor's area code
  const areaCode = preferredAreaCode || extractAreaCode(contractor.existing_phone_number) || '888';

  let twilioNumber;
  try {
    // Try to find a local number in their area code
    const available = await twilioClient.availablePhoneNumbers('US')
      .local.list({ areaCode, limit: 1 });

    if (available.length > 0) {
      twilioNumber = await twilioClient.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        friendlyName: `CrewBox - ${contractor.business_name}`,
        // Webhook: when call comes in, hit our handler
        voiceUrl: `${process.env.APP_URL}/api/webhooks/vapi/inbound`,
        voiceMethod: 'POST',
        statusCallback: `${process.env.APP_URL}/api/webhooks/vapi/status`,
        statusCallbackMethod: 'POST',
      });
    } else {
      // Fall back to toll-free if no local available
      const tollFree = await twilioClient.availablePhoneNumbers('US')
        .tollFree.list({ limit: 1 });
      twilioNumber = await twilioClient.incomingPhoneNumbers.create({
        phoneNumber: tollFree[0].phoneNumber,
        friendlyName: `CrewBox - ${contractor.business_name}`,
        voiceUrl: `${process.env.APP_URL}/api/webhooks/vapi/inbound`,
        voiceMethod: 'POST',
      });
    }
  } catch (err) {
    throw new Error(`Failed to provision phone number: ${err.message}`);
  }

  // Import that Twilio number into Vapi
  const vapiPhoneNumber = await vapi.phoneNumbers.create({
    provider: 'twilio',
    number: twilioNumber.phoneNumber,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    name: `${contractor.business_name} Receptionist`,
    assistantId: null, // will be set after assistant is created
  });

  // Save to database
  await supabase.from('contractors').update({
    ai_phone_number: twilioNumber.phoneNumber,
    vapi_phone_number_id: vapiPhoneNumber.id,
  }).eq('id', contractorId);

  return {
    aiPhoneNumber: twilioNumber.phoneNumber,
    vapiPhoneNumberId: vapiPhoneNumber.id,
    message: `AI number ${twilioNumber.phoneNumber} provisioned. Contractor forwards ${contractor.existing_phone_number} to this number.`,
  };
}

// ============================================================
// PART 2: CREATE THE VAPI ASSISTANT
// Customized per contractor — knows their business, hours, pricing
// ============================================================

export async function createReceptionistAssistant(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      *,
      agent_configs!inner (settings)
    `)
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'receptionist')
    .single();

  const agentSettings = contractor.agent_configs?.[0]?.settings || {};

  // Build the system prompt — this is what makes the AI feel like THEIR receptionist
  const systemPrompt = buildReceptionistPrompt(contractor, agentSettings);

  const assistant = await vapi.assistants.create({
    name: `${contractor.business_name} Receptionist`,

    // The AI's voice
    voice: {
      provider: 'eleven-labs',
      voiceId: agentSettings.voice_id || 'maya',   // professional female voice
      stability: 0.5,
      similarityBoost: 0.75,
    },

    // The AI brain
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: systemPrompt },
      ],
      temperature: 0.4,  // slightly creative but mostly consistent
      maxTokens: 250,    // keep responses concise for voice
    },

    // Transcription
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      smartFormat: true,
      keywords: [
        contractor.business_name,
        contractor.trade_type,
        contractor.address_city,
        contractor.trade_specialty || '',
      ].filter(Boolean),
    },

    // Call behavior
    firstMessage: buildGreeting(contractor),
    endCallMessage: 'Thank you for calling. Have a great day!',
    endCallPhrases: ['goodbye', 'bye', 'thank you goodbye', 'that\'s all'],

    // How long to wait for speech before timing out
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: (agentSettings.max_call_duration_minutes || 10) * 60,
    backgroundDenoisingEnabled: true,

    // Tools the AI can use during the call
    tools: buildReceptionistTools(contractor, agentSettings),

    // What data to collect during the call
    structuredDataPlan: {
      schema: {
        type: 'object',
        properties: {
          caller_name:        { type: 'string', description: 'Full name of the caller' },
          caller_phone:       { type: 'string', description: 'Phone number of the caller' },
          service_address:    { type: 'string', description: 'Address where work is needed' },
          problem_description: { type: 'string', description: 'What the customer needs help with' },
          urgency:            { type: 'string', enum: ['emergency', 'urgent', 'normal', 'flexible'] },
          preferred_date:     { type: 'string', description: 'When they want the appointment' },
          preferred_time:     { type: 'string', description: 'Time preference for appointment' },
          appointment_booked: { type: 'boolean', description: 'Whether an appointment was booked' },
          requires_callback:  { type: 'boolean', description: 'Whether owner needs to call back' },
          transfer_requested: { type: 'boolean', description: 'Whether caller asked for a human' },
        },
      },
    },

    // Post-call webhook — fires when call ends
    serverUrl: `${process.env.APP_URL}/api/webhooks/vapi/call-ended`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,

    // Metadata for our lookup
    metadata: {
      contractor_id: contractorId,
      platform: 'crewbox',
    },
  });

  // Link assistant to this contractor's phone number
  if (contractor.vapi_phone_number_id) {
    await vapi.phoneNumbers.update(contractor.vapi_phone_number_id, {
      assistantId: assistant.id,
    });
  }

  // Save assistant ID to agent_configs
  await supabase.from('agent_configs').update({
    vapi_assistant_id: assistant.id,
    status: 'active',
    last_active_at: new Date().toISOString(),
  }).eq('contractor_id', contractorId)
    .eq('agent_type', 'receptionist');

  return {
    assistantId: assistant.id,
    message: `Receptionist assistant created and linked to ${contractor.business_name}`,
  };
}

// ============================================================
// PART 3: BUILD THE SYSTEM PROMPT
// This is the secret sauce — highly specific to each contractor
// ============================================================

function buildReceptionistPrompt(contractor, settings) {
  const hours = contractor.business_hours || {};
  const hoursText = Object.entries(hours)
    .map(([day, time]) => `${day.charAt(0).toUpperCase() + day.slice(1)}: ${time}`)
    .join(', ');

  return `You are the professional receptionist for ${contractor.business_name}, a ${formatTrade(contractor.trade_type)} company based in ${contractor.address_city}, ${contractor.address_state}.

## YOUR IDENTITY
- You work for ${contractor.business_name} — never mention "CrewBox" or "AI"
- Your job is to make callers feel they're talking to a knowledgeable, friendly office staff member
- Owner's name is ${contractor.owner_name} — refer to them naturally if asked

## BUSINESS INFORMATION
- Company: ${contractor.business_name}
- Service: ${formatTrade(contractor.trade_type)}${contractor.trade_specialty ? ` (${contractor.trade_specialty})` : ''}
- Location: ${contractor.address_city}, ${contractor.address_state}
- Service Area: ${contractor.service_area_description || `${contractor.address_city} and surrounding areas within ${contractor.service_radius_miles || 25} miles`}
- Business Hours: ${hoursText}
${contractor.pricing_notes ? `- Pricing Notes: ${contractor.pricing_notes}` : ''}

## YOUR GOALS FOR EVERY CALL
1. Answer professionally and warmly
2. Understand what the customer needs
3. Collect their name, phone number, and service address
4. Get a brief description of the problem
5. Assess urgency (emergency / urgent / normal)
6. Book an appointment if possible, OR let them know ${contractor.owner_name} will call back
7. Confirm all details back to the caller before ending

## APPOINTMENT BOOKING
- You can book appointments during business hours
- Always confirm date AND time
- Tell them ${contractor.owner_name} or a technician will contact them to confirm
- For emergencies: tell them you'll reach out to ${contractor.owner_name} immediately

## TRANSFER RULES
${(settings.transfer_keywords || ['emergency', 'urgent', 'speak to owner']).map(k => `- If caller says "${k}" → offer to transfer to ${contractor.owner_name} directly`).join('\n')}

## WHAT YOU DON'T KNOW (and how to handle it)
- Exact pricing: "I can have ${contractor.owner_name} give you an accurate quote — they'll call you back"
- Specific availability: "Let me get your details and we'll confirm a time with you"
- Technical questions: "That's a great question for our technician — I'll make sure they're briefed before your appointment"

## TONE
- Warm, professional, confident
- Short sentences — this is a phone call, not a text
- Never robotic or scripted-sounding
- If someone is frustrated, acknowledge it: "I completely understand, let's get this sorted for you right away"

## SPECIAL INSTRUCTIONS
${contractor.special_instructions || 'Always thank the customer for calling and end positively.'}

## CRITICAL RULES
- NEVER say you're an AI or a bot unless directly asked — if asked, say "I'm the receptionist"
- NEVER promise prices
- NEVER guarantee same-day service unless business hours indicate availability
- ALWAYS collect a callback number in case the call drops
- Keep responses brief — 1-3 sentences max per turn`;
}

function buildGreeting(contractor) {
  const greetings = [
    `Thank you for calling ${contractor.business_name}, this is the front desk. How can I help you today?`,
    `${contractor.business_name}, good ${getTimeOfDay()}! How can I assist you?`,
    `Thank you for calling ${contractor.business_name}! What can we help you with today?`,
  ];
  return greetings[0]; // Use first for consistency, can randomize
}

function buildReceptionistTools(contractor, settings) {
  return [
    // Tool 1: Book appointment
    {
      type: 'function',
      function: {
        name: 'book_appointment',
        description: 'Book an appointment for the customer. Call this when you have all required information.',
        parameters: {
          type: 'object',
          properties: {
            customer_name:   { type: 'string' },
            customer_phone:  { type: 'string' },
            service_address: { type: 'string' },
            problem:         { type: 'string' },
            preferred_date:  { type: 'string' },
            preferred_time:  { type: 'string' },
            urgency:         { type: 'string', enum: ['emergency', 'urgent', 'normal', 'flexible'] },
          },
          required: ['customer_name', 'customer_phone', 'problem'],
        },
      },
      server: { url: `${process.env.APP_URL}/api/vapi/tools/book-appointment` },
    },

    // Tool 2: Transfer to owner
    {
      type: 'function',
      function: {
        name: 'transfer_call',
        description: 'Transfer the call to the business owner when requested or for emergencies.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why the transfer is needed' },
          },
          required: ['reason'],
        },
      },
      server: { url: `${process.env.APP_URL}/api/vapi/tools/transfer-call` },
    },

    // Tool 3: Check service area
    {
      type: 'function',
      function: {
        name: 'check_service_area',
        description: 'Check if an address is within the service area before booking.',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            zip_code: { type: 'string' },
          },
          required: ['zip_code'],
        },
      },
      server: { url: `${process.env.APP_URL}/api/vapi/tools/check-service-area` },
    },
  ];
}

// ============================================================
// PART 4: VAPI TOOL HANDLERS
// These are called by the AI DURING the call
// ============================================================

export async function handleBookAppointment(contractorId, toolArgs, callId) {
  const {
    customer_name, customer_phone, service_address,
    problem, preferred_date, preferred_time, urgency,
  } = toolArgs;

  // Find or create customer
  let customerId;
  const { data: existingCustomer } = await supabase
    .from('customers')
    .select('id')
    .eq('contractor_id', contractorId)
    .eq('phone', customer_phone)
    .single();

  if (existingCustomer) {
    customerId = existingCustomer.id;
    // Update last contact
    await supabase.from('customers').update({
      last_contact_date: new Date().toISOString(),
      name: customer_name, // update name if changed
    }).eq('id', customerId);
  } else {
    // Create new customer
    const { data: newCustomer } = await supabase
      .from('customers')
      .insert({
        contractor_id: contractorId,
        name: customer_name,
        phone: customer_phone,
        address_street: service_address,
        first_contact_date: new Date().toISOString(),
        last_contact_date: new Date().toISOString(),
        lead_source: 'phone_call',
      })
      .select()
      .single();
    customerId = newCustomer.id;
  }

  // Create job record
  const { data: job } = await supabase
    .from('jobs')
    .insert({
      contractor_id: contractorId,
      customer_id: customerId,
      title: `${problem.slice(0, 60)}`,
      description: problem,
      status: 'inquiry',
      priority: urgency === 'emergency' ? 'emergency' : urgency === 'urgent' ? 'high' : 'normal',
      service_address,
      source: 'ai_call',
      source_call_id: callId,
      requested_date: preferred_date ? new Date(preferred_date).toISOString() : null,
    })
    .select()
    .single();

  // Update call to reference job
  await supabase.from('calls').update({
    customer_id: customerId,
    job_id: job.id,
    appointment_booked: true,
  }).eq('vapi_call_id', callId);

  // Log activity
  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'receptionist',
    action: 'appointment_booked',
    entity_type: 'job',
    entity_id: job.id,
    description: `Appointment booked: ${customer_name} — ${problem.slice(0, 80)}`,
  });

  // Return confirmation text for AI to say
  const dateText = preferred_date && preferred_time
    ? `for ${preferred_date} at ${preferred_time}`
    : 'and someone will be in touch to confirm the appointment time';

  return {
    success: true,
    message: `Perfect! I've booked your appointment ${dateText}. You'll receive a confirmation text shortly at ${customer_phone}.`,
    jobId: job.id,
    customerId,
  };
}

export async function handleTransferCall(contractorId, reason) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('owner_phone, owner_name')
    .eq('id', contractorId)
    .single();

  // Return transfer destination — Vapi handles the actual transfer
  return {
    phoneNumber: contractor.owner_phone,
    message: `Let me connect you with ${contractor.owner_name} right now. Please hold for just a moment.`,
  };
}

export async function handleCheckServiceArea(contractorId, zipCode) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('service_areas, service_radius_miles, address_zip')
    .eq('id', contractorId)
    .single();

  // Check if zip is in service areas array
  const inServiceArea = !contractor.service_areas?.length ||
    contractor.service_areas.includes(zipCode);

  return {
    inServiceArea,
    message: inServiceArea
      ? 'Great news, that location is within our service area!'
      : `Unfortunately, that area is currently outside our service zone. We typically serve within ${contractor.service_radius_miles || 25} miles of ${contractor.address_zip}.`,
  };
}

// ============================================================
// PART 5: CALL-ENDED WEBHOOK HANDLER
// Vapi calls this when the call is over
// We save transcript, notify contractor, send customer SMS
// ============================================================

export async function handleCallEnded(vapiPayload) {
  const {
    call,
    artifact: { transcript, recordingUrl, structuredData },
    analysis: { summary, successEvaluation },
  } = vapiPayload;

  const contractorId = call.metadata?.contractor_id;
  if (!contractorId) throw new Error('No contractor_id in call metadata');

  const { data: contractor } = await supabase
    .from('contractors')
    .select('business_name, owner_phone, owner_name')
    .eq('id', contractorId)
    .single();

  // 1. Save complete call record
  const { data: callRecord } = await supabase
    .from('calls')
    .upsert({
      contractor_id: contractorId,
      vapi_call_id: call.id,
      caller_phone: call.customer?.number,
      caller_name: structuredData?.caller_name,
      direction: 'inbound',
      duration_seconds: call.endedAt
        ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
        : 0,
      outcome: determineOutcome(structuredData, successEvaluation),
      transcript,
      summary,
      recording_url: recordingUrl || null,
      appointment_booked: structuredData?.appointment_booked || false,
      transferred_to: structuredData?.transfer_requested ? contractor.owner_phone : null,
      ai_confidence_score: successEvaluation?.score || null,
      required_human_followup: structuredData?.requires_callback || false,
      started_at: call.startedAt,
      ended_at: call.endedAt,
    }, { onConflict: 'vapi_call_id' })
    .select()
    .single();

  // 2. Send confirmation SMS to customer (if appointment booked)
  if (structuredData?.appointment_booked && structuredData?.caller_phone) {
    const apptText = structuredData.preferred_date && structuredData.preferred_time
      ? `on ${structuredData.preferred_date} at ${structuredData.preferred_time}`
      : 'soon — we\'ll confirm the time shortly';

    await twilioClient.messages.create({
      to: structuredData.caller_phone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `Hi ${structuredData.caller_name || 'there'}! Your appointment with ${contractor.business_name} is confirmed ${apptText}. We'll be in touch. Reply STOP to opt out.`,
    });
  }

  // 3. Send instant summary to contractor via SMS
  const ownerSummary = buildOwnerSummary(structuredData, summary, contractor);
  await twilioClient.messages.create({
    to: contractor.owner_phone,
    from: process.env.TWILIO_FROM_NUMBER,
    body: ownerSummary,
  });

  // 4. Log activity
  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'receptionist',
    action: 'call_completed',
    entity_type: 'call',
    entity_id: callRecord.id,
    description: `Call from ${structuredData?.caller_name || 'unknown'}: ${summary?.slice(0, 120) || 'Call completed'}`,
    metadata: {
      duration_seconds: callRecord.duration_seconds,
      appointment_booked: structuredData?.appointment_booked,
      outcome: callRecord.outcome,
    },
  });

  return { success: true, callId: callRecord.id };
}

// ============================================================
// PART 6: ASSISTANT UPDATER
// When contractor changes their hours/pricing/instructions
// ============================================================

export async function updateReceptionistAssistant(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      *,
      agent_configs!inner (vapi_assistant_id, settings)
    `)
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'receptionist')
    .single();

  const assistantId = contractor.agent_configs?.[0]?.vapi_assistant_id;
  if (!assistantId) throw new Error('No assistant ID found — run createReceptionistAssistant first');

  const agentSettings = contractor.agent_configs?.[0]?.settings || {};
  const systemPrompt = buildReceptionistPrompt(contractor, agentSettings);

  await vapi.assistants.update(assistantId, {
    firstMessage: buildGreeting(contractor),
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: systemPrompt }],
      temperature: 0.4,
      maxTokens: 250,
    },
  });

  return { updated: true, assistantId };
}

// ============================================================
// CALL ANALYTICS
// ============================================================

export async function getCallAnalytics(contractorId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: calls } = await supabase
    .from('calls')
    .select('outcome, duration_seconds, appointment_booked, started_at')
    .eq('contractor_id', contractorId)
    .gte('started_at', since.toISOString());

  if (!calls?.length) return { total: 0, booked: 0, bookingRate: 0, avgDuration: 0 };

  const total = calls.length;
  const booked = calls.filter(c => c.appointment_booked).length;
  const avgDuration = Math.round(calls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / total);
  const byOutcome = calls.reduce((acc, c) => {
    acc[c.outcome || 'unknown'] = (acc[c.outcome || 'unknown'] || 0) + 1;
    return acc;
  }, {});

  return {
    total,
    booked,
    bookingRate: Math.round((booked / total) * 100),
    avgDurationSeconds: avgDuration,
    byOutcome,
    period: `Last ${days} days`,
  };
}

// ============================================================
// HELPERS
// ============================================================

function determineOutcome(structuredData, successEvaluation) {
  if (structuredData?.appointment_booked) return 'booked';
  if (structuredData?.transfer_requested) return 'transferred';
  if (structuredData?.requires_callback) return 'callback';
  if (successEvaluation?.score < 0.3) return 'not_interested';
  return 'callback';
}

function buildOwnerSummary(data, summary, contractor) {
  if (!data) return `📞 Missed call for ${contractor.business_name}. Check your CrewBox dashboard for details.`;

  const lines = [`📞 New call — ${contractor.business_name}`];
  if (data.caller_name) lines.push(`👤 ${data.caller_name}${data.caller_phone ? ` · ${data.caller_phone}` : ''}`);
  if (data.problem_description) lines.push(`🔧 ${data.problem_description.slice(0, 100)}`);
  if (data.appointment_booked) lines.push(`✅ Appointment booked${data.preferred_date ? ` · ${data.preferred_date}` : ''}`);
  else lines.push(`📋 Follow-up needed`);
  lines.push(`📱 View full details: ${process.env.APP_URL}/calls`);

  return lines.join('\n');
}

function formatTrade(tradeType) {
  const names = {
    hvac: 'HVAC (Heating, Ventilation & Air Conditioning)',
    plumbing: 'plumbing',
    electrical: 'electrical',
    roofing: 'roofing',
    general_contractor: 'general contracting',
    cleaning: 'cleaning services',
    landscaping: 'landscaping',
    auto_repair: 'auto repair',
    painting: 'painting',
    flooring: 'flooring',
    pest_control: 'pest control',
    appliance_repair: 'appliance repair',
    other: 'contracting',
  };
  return names[tradeType] || tradeType;
}

function extractAreaCode(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10, -7) : null;
}

function getTimeOfDay() {
  const hour = new Date().getHours();
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}
