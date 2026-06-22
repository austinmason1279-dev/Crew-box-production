# CrewBox — Deployment Guide
# From Zero to Live for Turbo Roofing
# Estimated time: 3-4 hours

## THE 8 ACCOUNTS TO CREATE (in order)

### 1. SUPABASE — Database
URL: https://supabase.com | Cost: Free
- Sign up with GitHub
- New Project → name: crewbox-production
- Settings → API → SAVE THESE:
  SUPABASE_URL = https://XXXXX.supabase.co
  SUPABASE_ANON_KEY = eyJ...
  SUPABASE_SERVICE_ROLE_KEY = eyJ...  ← SECRET

### 2. VERCEL — Hosting
URL: https://vercel.com | Cost: Free
- Sign up with GitHub
- Don't create project yet — do after code is ready

### 3. VAPI — Voice AI
URL: https://vapi.ai | Cost: ~$0.05/min
- Sign up → API Keys → Create key
  VAPI_API_KEY = vapi_XXXXX
- Phone Numbers → Buy number (Dallas 214 area code)
  VAPI_PHONE_NUMBER_ID = pn_XXXXX
  AI_PHONE_NUMBER = (214) 555-XXXX  ← save the actual number

### 4. TWILIO — SMS
URL: https://twilio.com | Cost: $15 credit free
- Sign up → Dashboard shows credentials immediately
  TWILIO_ACCOUNT_SID = ACxxxxxxxxxxx
  TWILIO_AUTH_TOKEN = xxxxxxxxxx
- Buy a number → Dallas area code
  TWILIO_FROM_NUMBER = +12145550000

### 5. ANTHROPIC — Claude AI
URL: https://console.anthropic.com | Cost: ~$0.003/msg
- Sign up → add $10 → API Keys → Create
  ANTHROPIC_API_KEY = sk-ant-XXXXX

### 6. AWS — File Storage
URL: https://aws.amazon.com | Cost: Free tier
- Create account → S3 → Create 3 buckets:
  crewbox-documents-prod  (block all public access)
  crewbox-recordings-prod (block all public access)
  crewbox-media-prod      (block all public access)
- IAM → Users → Create user → AmazonS3FullAccess
- Create access key:
  AWS_ACCESS_KEY_ID = AKIAXXXXX
  AWS_SECRET_ACCESS_KEY = XXXXX
  AWS_REGION = us-east-1

### 7. RESEND — Email
URL: https://resend.com | Cost: Free (3000 emails/mo)
- Sign up → API Keys → Create
  RESEND_API_KEY = re_XXXXX
- Domains → Add getcrewbox.com → verify DNS

### 8. STRIPE — Payments
URL: https://stripe.com | Cost: 2.9% + 30c per txn
- Create account → Developers → API Keys
  STRIPE_SECRET_KEY = sk_test_XXXXX
  STRIPE_PUBLISHABLE_KEY = pk_test_XXXXX
- Webhooks → Add endpoint → URL: https://YOUR-APP.vercel.app/api/webhooks/stripe
  Events: payment_intent.succeeded, payment_intent.payment_failed,
          customer.subscription.updated, account.updated, payout.paid
  STRIPE_WEBHOOK_SECRET = whsec_XXXXX
- Products → Create 3 subscription prices:
  STRIPE_STARTER_PRICE_ID = price_XXXXX    ($297/mo)
  STRIPE_GROWTH_PRICE_ID = price_XXXXX     ($597/mo)
  STRIPE_ENTERPRISE_PRICE_ID = price_XXXXX ($1497/mo)

---

## PHASE 2: SET UP DATABASE (20 min)

1. Supabase → SQL Editor → New Query
2. Paste contents of: supabase/migrations/001_schema.sql → Run
3. New Query → Paste: supabase/rls/002_rls_policies.sql → Run
4. Database → Replication → Enable for:
   activity_log, calls, invoices, reviews
5. Authentication → Settings:
   Site URL: https://getcrewbox.com
   Redirect URLs: https://app.getcrewbox.com/auth/callback

---

## PHASE 3: DEPLOY CODE (30 min)

### Push to GitHub:
git init
git add .
git commit -m "CrewBox v1.0 — deploy"
git remote add origin https://github.com/YOUR/crewbox.git
git push -u origin main

### Deploy to Vercel:
1. vercel.com → New Project → Import from GitHub
2. Framework: Other | Build: (empty) | Output: (empty)
3. Deploy → get URL: https://crewbox-XXXX.vercel.app

### Add ALL environment variables in Vercel:
Settings → Environment Variables → add each one below

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
S3_BUCKET_DOCUMENTS=crewbox-documents-prod
S3_BUCKET_RECORDINGS=crewbox-recordings-prod
S3_BUCKET_MEDIA=crewbox-media-prod
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_STARTER_PRICE_ID=
STRIPE_GROWTH_PRICE_ID=
STRIPE_ENTERPRISE_PRICE_ID=
VAPI_API_KEY=
VAPI_PHONE_NUMBER_ID=
VAPI_WEBHOOK_SECRET=crewbox-vapi-secret-2026
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
APP_URL=https://crewbox-XXXX.vercel.app
NODE_ENV=production
CRON_SECRET=crewbox-cron-secret-2026

### After deploy — update webhooks:
- Twilio → your number → Voice URL:
  https://crewbox-XXXX.vercel.app/api/webhooks/vapi/inbound
- Stripe → webhook URL:
  https://crewbox-XXXX.vercel.app/api/webhooks/stripe

---

## PHASE 4: TEST (30 min)

1. Open: https://crewbox-XXXX.vercel.app/health
   Should return: {"status":"ok","platform":"CrewBox"}

2. Supabase → Authentication → Users → Invite yourself
   Then SQL Editor:
   UPDATE auth.users
   SET raw_app_meta_data = '{"role":"platform_admin"}'
   WHERE email = 'YOUR_EMAIL';

3. Call your Vapi number directly
   Should ring and be answered (generic greeting until Turbo Roofing set up)

---

## PHASE 5: ONBOARD TURBO ROOFING (15 min)

### Add to database:
Supabase → SQL Editor:

INSERT INTO licensees (
  company_name, slug, owner_name, owner_email,
  brand_name, subscription_tier, subscription_status,
  max_contractor_accounts, is_active
) VALUES (
  'Turbo Roofing', 'turbo-roofing', 'YOUR NAME', 'YOUR_EMAIL',
  'Turbo Roofing', 'growth', 'active', 50, true
) RETURNING id;
-- Save the ID

### Run setup wizard:
Open frontend/setup-wizard.html or https://crewbox-XXXX.vercel.app/setup

Fill in:
- Business Name: Turbo Roofing
- Trade: Roofing
- Phone: their existing number
- City: their city
- Phone Method: Call Forward
- AI Number: your Vapi number

### Set up call forwarding:
Call their carrier:
"I'd like to set up call forwarding when I don't answer
to [VAPI NUMBER]"
OR dial: **61*[VAPI_NUMBER_DIGITS]# from their phone

---

## PHASE 6: VERIFY IT WORKS

THE MOMENT OF TRUTH:
1. Call Turbo Roofing's existing number from another phone
2. Let it ring 3-4 times WITHOUT answering
3. AI should answer: "Thank you for calling Turbo Roofing..."
4. Have a conversation — ask about a roof quote
5. AI books the appointment

Then check:
- Supabase → calls table → call record appears ✓
- Supabase → customers table → customer created ✓
- Supabase → jobs table → job booked ✓
- Owner's phone → SMS summary received ✓

---

## MONTH 1 COST ESTIMATE

Supabase:   $0 (free tier)
Vercel:     $0 (free tier)
AWS S3:     $0 (free tier)
Vapi:       $10-30 (per minute)
Twilio:     $0 (from $15 credit)
Anthropic:  $5-15 (per use)
Resend:     $0 (free tier)
Stripe:     $0 (% only when paid)
TOTAL:      ~$15-45 month 1

---

## QUICK TROUBLESHOOTING

AI not answering:
→ Check Twilio webhook URL is correct
→ Check Vapi API key in Vercel env vars
→ Call Vapi number directly (bypass forwarding) to test

Database errors:
→ Vercel → Functions → Logs → look for error
→ Check SUPABASE_SERVICE_ROLE_KEY is set

Emails not sending:
→ Check Resend domain is verified
→ Check RESEND_API_KEY in Vercel

Stripe webhooks failing:
→ Stripe → Webhooks → check event log
→ Verify webhook URL matches exactly

---

## SUCCESS CHECKLIST

Day 1:
[ ] All 8 accounts created and keys saved
[ ] Database schema deployed (001 + 002 SQL files)
[ ] Code on GitHub and deployed to Vercel
[ ] Health check returns OK
[ ] Turbo Roofing in database
[ ] Call forwarding set up
[ ] AI answers a test call  <-- THIS IS THE MOMENT

Week 1:
[ ] Real calls being handled
[ ] Jobs being booked by AI
[ ] Owner getting SMS summaries
[ ] Call records in database

Week 2:
[ ] Count jobs booked by AI: ___
[ ] Count revenue from AI calls: $___
[ ] This becomes your case study
