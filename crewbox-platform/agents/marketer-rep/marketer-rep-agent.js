// ============================================================
// CREWBOX — MARKETER + REP AGENTS
// File: agents/marketer-rep/marketer-rep-agent.js
//
// MARKETER: Turns job photos into social posts automatically
//   - Google Business Profile
//   - Facebook Business Page
//   - Instagram Business
//
// REP: Manages online reputation
//   - Sends review requests after job completion
//   - AI-writes responses to all reviews (good and bad)
//   - Monitors rating trends
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ============================================================
// ── MARKETER AGENT ──────────────────────────────────────────
// ============================================================

/**
 * Generate and schedule a social post from completed job photos
 * Called when a job is marked complete and has photos attached
 */
export async function createJobPost(contractorId, jobId, photoUrls) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      business_name, trade_type, trade_specialty,
      address_city, address_state,
      agent_configs!inner (settings)
    `)
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'marketer')
    .single();

  const { data: job } = await supabase
    .from('jobs')
    .select('title, description, completion_notes, trade_category, service_city')
    .eq('id', jobId)
    .single();

  const settings = contractor.agent_configs?.[0]?.settings || {};
  const platforms = settings.platforms || ['google_business', 'facebook'];

  // Generate caption with Claude
  const caption = await generateSocialCaption(contractor, job, platforms);
  const hashtags = generateHashtags(contractor.trade_type, contractor.address_city, contractor.address_state);

  // Save post to database
  const scheduledAt = getNextPostTime(settings.post_frequency || 'weekly');

  const { data: post } = await supabase
    .from('social_posts')
    .insert({
      contractor_id: contractorId,
      job_id: jobId,
      caption,
      image_urls: photoUrls,
      hashtags,
      platforms,
      platform_status: Object.fromEntries(platforms.map(p => [p, 'scheduled'])),
      scheduled_at: scheduledAt.toISOString(),
      ai_generated: true,
    })
    .select()
    .single();

  // Publish immediately or at scheduled time
  if (settings.post_immediately) {
    await publishPost(post.id, contractorId, platforms, photoUrls, caption, hashtags);
  }

  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'marketer',
    action: 'post_scheduled',
    entity_type: 'social_post',
    entity_id: post.id,
    description: `Social post scheduled for ${platforms.join(' + ')} — "${caption.slice(0, 60)}..."`,
  });

  return { postId: post.id, caption, hashtags, scheduledAt, platforms };
}

async function generateSocialCaption(contractor, job, platforms) {
  const isGoogle = platforms.includes('google_business');
  const prompt = `You write social media posts for ${contractor.business_name}, a ${contractor.trade_type} company in ${contractor.address_city}, ${contractor.address_state}.

Job completed: ${job.title}
${job.completion_notes ? `Notes: ${job.completion_notes}` : ''}
${job.service_city ? `Location: ${job.service_city}` : ''}

Write a single social media caption that:
1. Sounds like a proud local business owner, not a corporation
2. Describes the work in plain language a homeowner would understand
3. Subtly highlights quality and reliability
4. ${isGoogle ? 'For Google Business — no hashtags in the caption itself' : 'Ends naturally (hashtags will be added separately)'}
5. Is 2-4 sentences max
6. Does NOT use generic phrases like "We are proud to announce" or "Excited to share"

Return ONLY the caption text. No quotes, no hashtags, no formatting.`;

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

function generateHashtags(tradeType, city, state) {
  const tradeHashtags = {
    hvac: ['#HVAC', '#HVACTech', '#AirConditioning', '#HeatingAndCooling', '#HVACService'],
    plumbing: ['#Plumbing', '#Plumber', '#PlumbingService', '#PlumbingRepair'],
    electrical: ['#Electrician', '#ElectricalWork', '#ElectricalService', '#ElectricalContractor'],
    roofing: ['#Roofing', '#RoofRepair', '#RoofReplacement', '#Roofer'],
    general_contractor: ['#Contractor', '#HomeImprovement', '#Remodeling', '#Construction'],
    cleaning: ['#Cleaning', '#CleaningService', '#CommercialCleaning', '#CleanHome'],
    landscaping: ['#Landscaping', '#LawnCare', '#LandscapeDesign', '#Gardening'],
    painting: ['#Painting', '#PainterLife', '#HousePainting', '#PaintingContractor'],
    other: ['#HomeServices', '#Contractor', '#LocalBusiness'],
  };

  const cityTag = `#${city.replace(/\s+/g, '')}`;
  const stateTag = `#${state}`;
  const tradeTags = tradeHashtags[tradeType] || tradeHashtags.other;

  return [...tradeTags.slice(0, 3), cityTag, stateTag, '#LocalBusiness', '#SmallBusiness'].slice(0, 7);
}

async function publishPost(postId, contractorId, platforms, photoUrls, caption, hashtags) {
  const fullCaption = `${caption}\n\n${hashtags.join(' ')}`;
  const platformResults = {};

  for (const platform of platforms) {
    try {
      switch (platform) {
        case 'google_business':
          platformResults.google_business = await postToGoogleBusiness(contractorId, caption, photoUrls);
          break;
        case 'facebook':
          platformResults.facebook = await postToFacebook(contractorId, fullCaption, photoUrls);
          break;
        case 'instagram':
          platformResults.instagram = await postToInstagram(contractorId, fullCaption, photoUrls);
          break;
      }
    } catch (err) {
      platformResults[platform] = { status: 'failed', error: err.message };
    }
  }

  const allStatuses = Object.fromEntries(
    Object.entries(platformResults).map(([k, v]) => [k, v.status || 'posted'])
  );

  await supabase.from('social_posts').update({
    platform_status: allStatuses,
    platform_post_ids: Object.fromEntries(
      Object.entries(platformResults).map(([k, v]) => [k, v.postId || null])
    ),
    published_at: new Date().toISOString(),
  }).eq('id', postId);

  return platformResults;
}

// Google Business Profile API
async function postToGoogleBusiness(contractorId, caption, photoUrls) {
  // Requires Google Business Profile API OAuth token stored per contractor
  const { data: contractor } = await supabase
    .from('contractors')
    .select('agent_configs!inner(settings)')
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'marketer')
    .single();

  const settings = contractor?.agent_configs?.[0]?.settings || {};
  const accessToken = settings.google_access_token;
  const locationId = settings.google_location_id;

  if (!accessToken || !locationId) {
    return { status: 'skipped', reason: 'Google Business not connected' };
  }

  const postBody = {
    languageCode: 'en-US',
    summary: caption,
    callToAction: { actionType: 'CALL' },
    media: photoUrls.slice(0, 1).map(url => ({
      mediaFormat: 'PHOTO',
      sourceUrl: url,
    })),
  };

  const response = await fetch(
    `https://mybusiness.googleapis.com/v4/${locationId}/localPosts`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postBody),
    }
  );

  if (!response.ok) throw new Error(`Google API error: ${response.status}`);
  const data = await response.json();
  return { status: 'posted', postId: data.name };
}

// Facebook Graph API
async function postToFacebook(contractorId, caption, photoUrls) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('agent_configs!inner(settings)')
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'marketer')
    .single();

  const settings = contractor?.agent_configs?.[0]?.settings || {};
  const pageAccessToken = settings.facebook_page_token;
  const pageId = settings.facebook_page_id;

  if (!pageAccessToken || !pageId) {
    return { status: 'skipped', reason: 'Facebook page not connected' };
  }

  let postId;
  if (photoUrls?.length > 0) {
    // Post with photo
    const formData = new URLSearchParams({
      url: photoUrls[0],
      caption,
      access_token: pageAccessToken,
    });
    const res = await fetch(`https://graph.facebook.com/${pageId}/photos`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    postId = data.id;
  } else {
    const formData = new URLSearchParams({ message: caption, access_token: pageAccessToken });
    const res = await fetch(`https://graph.facebook.com/${pageId}/feed`, { method: 'POST', body: formData });
    const data = await res.json();
    postId = data.id;
  }

  return { status: 'posted', postId };
}

// Instagram Graph API (via Facebook)
async function postToInstagram(contractorId, caption, photoUrls) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('agent_configs!inner(settings)')
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'marketer')
    .single();

  const settings = contractor?.agent_configs?.[0]?.settings || {};
  const igAccountId = settings.instagram_account_id;
  const pageAccessToken = settings.facebook_page_token;

  if (!igAccountId || !pageAccessToken || !photoUrls?.length) {
    return { status: 'skipped', reason: 'Instagram not connected or no photo' };
  }

  // Step 1: Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v18.0/${igAccountId}/media`,
    {
      method: 'POST',
      body: new URLSearchParams({
        image_url: photoUrls[0],
        caption,
        access_token: pageAccessToken,
      }),
    }
  );
  const container = await containerRes.json();

  // Step 2: Publish
  const publishRes = await fetch(
    `https://graph.facebook.com/v18.0/${igAccountId}/media_publish`,
    {
      method: 'POST',
      body: new URLSearchParams({
        creation_id: container.id,
        access_token: pageAccessToken,
      }),
    }
  );
  const published = await publishRes.json();
  return { status: 'posted', postId: published.id };
}

function getNextPostTime(frequency) {
  const now = new Date();
  if (frequency === 'immediate') return now;
  // Schedule for 9am next weekday
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  else next.setDate(next.getDate() + 1);
  return next;
}

// ============================================================
// ── REP AGENT ───────────────────────────────────────────────
// ============================================================

/**
 * Send review request after job completion
 * Called 24 hours after job marked complete
 */
export async function sendReviewRequest(contractorId, jobId, customerId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select(`
      business_name,
      agent_configs!inner (settings)
    `)
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'rep')
    .single();

  const { data: customer } = await supabase
    .from('customers')
    .select('name, phone, email')
    .eq('id', customerId)
    .single();

  const settings = contractor.agent_configs?.[0]?.settings || {};

  // Check: never send more than 1 review request per customer
  const { data: existing } = await supabase
    .from('reviews')
    .select('id')
    .eq('contractor_id', contractorId)
    .eq('customer_id', customerId)
    .not('request_sent_at', 'is', null);

  if (existing?.length > 0) return { skipped: true, reason: 'Already requested' };

  const googleReviewLink = settings.google_review_link || `https://search.google.com/local/reviews?placeid=${settings.google_place_id}`;

  const message = await generateReviewRequestMessage(
    contractor.business_name,
    customer.name,
    googleReviewLink
  );

  if (customer.phone) {
    await twilioClient.messages.create({
      to: customer.phone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: message,
    });
  }

  // Log the request
  await supabase.from('reviews').insert({
    contractor_id: contractorId,
    customer_id: customerId,
    job_id: jobId,
    platform: 'google',
    request_sent_at: new Date().toISOString(),
    request_sent_via: customer.phone ? 'sms' : 'email',
  });

  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'rep',
    action: 'review_request_sent',
    entity_type: 'review',
    description: `Review request sent to ${customer.name}`,
  });

  return { sent: true, to: customer.phone || customer.email };
}

async function generateReviewRequestMessage(businessName, customerName, reviewLink) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Write a brief, warm SMS asking ${customerName || 'the customer'} to leave a Google review for ${businessName}. 
Include this link: ${reviewLink}
Keep it under 160 characters. Sound human, grateful, never pushy. Return only the SMS text.`,
    }],
  });
  return response.content[0].text.trim();
}

/**
 * Respond to a new review (AI-generated, optionally human-approved)
 */
export async function respondToReview(reviewId, contractorId, autoPost = false) {
  const { data: review } = await supabase
    .from('reviews')
    .select('*, contractors(business_name, owner_name, agent_configs!inner(settings))')
    .eq('id', reviewId)
    .single();

  if (!review) throw new Error('Review not found');

  const settings = review.contractors?.agent_configs?.[0]?.settings || {};
  const isNegative = review.rating <= 2;

  // For negative reviews, always require human approval first
  if (isNegative && !settings.auto_respond_to_negative) {
    // Flag for owner review
    await supabase.from('reviews').update({
      ai_generated_response: true,
      response_approved: false,
    }).eq('id', reviewId);

    // Alert the contractor
    const { data: contractor } = await supabase
      .from('contractors')
      .select('owner_phone, business_name')
      .eq('id', contractorId)
      .single();

    if (contractor?.owner_phone) {
      await twilioClient.messages.create({
        to: contractor.owner_phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `⭐ CrewBox: New ${review.rating}-star review from ${review.reviewer_name || 'a customer'} on ${review.platform}. Please review and approve a response: ${process.env.APP_URL}/reviews/${reviewId}`,
      });
    }

    // Still generate the response for them to approve
  }

  // Generate response
  const response = await generateReviewResponse(review, review.contractors);

  // Save to database
  await supabase.from('reviews').update({
    response_text: response,
    ai_generated_response: true,
    response_approved: (!isNegative && autoPost) || false,
  }).eq('id', reviewId);

  // Auto-post if positive and auto-post enabled
  if (!isNegative && (autoPost || settings.auto_respond_to_positive)) {
    await postReviewResponse(review, response, settings);
    await supabase.from('reviews').update({
      responded_at: new Date().toISOString(),
      response_approved: true,
    }).eq('id', reviewId);
  }

  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'rep',
    action: isNegative ? 'review_flagged' : 'review_responded',
    entity_type: 'review',
    entity_id: reviewId,
    description: `${review.rating}⭐ review from ${review.reviewer_name || 'customer'} — response ${isNegative ? 'drafted for approval' : 'posted'}`,
  });

  return { response, requiresApproval: isNegative, reviewId };
}

async function generateReviewResponse(review, contractor) {
  const isPositive = review.rating >= 4;
  const isNeutral = review.rating === 3;
  const isNegative = review.rating <= 2;

  const prompt = `You write responses to online reviews for ${contractor.business_name}.

Review details:
- Platform: ${review.platform}
- Rating: ${review.rating}/5 stars
- Reviewer: ${review.reviewer_name || 'A customer'}
- Review text: "${review.review_text || '(No text provided)'}"

Business owner's name: ${contractor.owner_name}

Write a response that:
${isPositive ? `
- Thanks them genuinely (not generically)
- References something specific they mentioned if possible
- Mentions the business name naturally
- Invites them back
- Is 2-4 sentences, warm and professional` : ''}
${isNeutral ? `
- Acknowledges their feedback graciously
- Shows commitment to improvement
- Offers to make it right / invites them to reach out
- Is professional, not defensive
- Is 3-5 sentences` : ''}
${isNegative ? `
- Acknowledges the concern without admitting fault if unclear
- Expresses genuine concern for their experience
- Offers to resolve it (provide phone/email)
- Is professional and empathetic — NEVER defensive or dismissive
- Does not argue with their account
- Is 3-5 sentences
- Ends with a direct invitation to discuss: "Please reach out to us at [phone/email]"` : ''}

Return ONLY the response text. No quotes, no formatting.`;

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

async function postReviewResponse(review, responseText, settings) {
  // Post to Google My Business API
  if (review.platform === 'google' && settings.google_access_token && review.external_review_id) {
    await fetch(
      `https://mybusiness.googleapis.com/v4/${settings.google_location_id}/reviews/${review.external_review_id}/reply`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${settings.google_access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ comment: responseText }),
      }
    );
  }
}

/**
 * Ingest new reviews from Google (run daily via cron)
 */
export async function syncGoogleReviews(contractorId) {
  const { data: contractor } = await supabase
    .from('contractors')
    .select('agent_configs!inner(settings)')
    .eq('id', contractorId)
    .eq('agent_configs.agent_type', 'rep')
    .single();

  const settings = contractor?.agent_configs?.[0]?.settings || {};
  if (!settings.google_access_token || !settings.google_location_id) return { skipped: true };

  const response = await fetch(
    `https://mybusiness.googleapis.com/v4/${settings.google_location_id}/reviews?pageSize=50`,
    { headers: { Authorization: `Bearer ${settings.google_access_token}` } }
  );

  if (!response.ok) throw new Error('Failed to fetch Google reviews');
  const data = await response.json();

  let newReviews = 0;
  for (const review of (data.reviews || [])) {
    const { data: existing } = await supabase
      .from('reviews')
      .select('id')
      .eq('contractor_id', contractorId)
      .eq('external_review_id', review.reviewId)
      .single();

    if (!existing) {
      await supabase.from('reviews').insert({
        contractor_id: contractorId,
        platform: 'google',
        external_review_id: review.reviewId,
        reviewer_name: review.reviewer?.displayName,
        rating: review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 :
                review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1,
        review_text: review.comment,
        review_date: review.createTime,
      });

      // Auto-trigger response generation
      const { data: newReview } = await supabase
        .from('reviews')
        .select('id')
        .eq('contractor_id', contractorId)
        .eq('external_review_id', review.reviewId)
        .single();

      if (newReview) await respondToReview(newReview.id, contractorId);
      newReviews++;
    }
  }

  return { synced: newReviews };
}

/**
 * Get reputation summary for dashboard
 */
export async function getReputationStats(contractorId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: reviews } = await supabase
    .from('reviews')
    .select('rating, platform, responded_at, review_date')
    .eq('contractor_id', contractorId);

  if (!reviews?.length) return { avgRating: 0, total: 0, responded: 0, byPlatform: {} };

  const avgRating = reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length;
  const responded = reviews.filter(r => r.responded_at).length;
  const recentReviews = reviews.filter(r => new Date(r.review_date) >= since);
  const recentAvg = recentReviews.length
    ? recentReviews.reduce((s, r) => s + (r.rating || 0), 0) / recentReviews.length
    : 0;

  const byPlatform = reviews.reduce((acc, r) => {
    if (!acc[r.platform]) acc[r.platform] = { count: 0, totalRating: 0 };
    acc[r.platform].count++;
    acc[r.platform].totalRating += r.rating || 0;
    return acc;
  }, {});

  Object.values(byPlatform).forEach(p => { p.avgRating = p.totalRating / p.count; });

  return {
    avgRating: Math.round(avgRating * 10) / 10,
    recentAvgRating: Math.round(recentAvg * 10) / 10,
    total: reviews.length,
    responded,
    responseRate: Math.round((responded / reviews.length) * 100),
    byPlatform,
  };
}
