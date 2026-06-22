# CrewBox Platform — Phase 1 Technical Architecture
## The Complete Backend Blueprint

---

## WHAT WAS BUILT IN PHASE 1

### 4 Production-Ready Files:

| File | What it does |
|------|-------------|
| `supabase/migrations/001_schema.sql` | Complete database — every table, enum, index, trigger, and materialized view |
| `supabase/rls/002_rls_policies.sql` | Row Level Security — tenant isolation at the database level |
| `stripe/stripe-service.js` | Full payment system — licensee billing, contractor onboarding, invoice collection, webhooks |
| `storage/storage-service.js` | Secure document storage — licenses, contracts, photos, call recordings |
| `auth/auth-service.js` | Authentication — 3 user roles, JWT claims, onboarding flow |

---

## THE DATA ARCHITECTURE

### Who Owns What

```
CREWBOX (Platform)
│   Owns: Infrastructure, AI, codebase, database schema
│   Stores: Everything, but with strict access controls
│
├── LICENSEE (e.g. "ProTrade AI")
│   Owns: Their brand, their client relationships, their pricing
│   Sees: ONLY their own contractors and their data
│   Cannot see: Other licensees or their contractors
│
└── CONTRACTOR (e.g. "Mike's HVAC")
    Owns: Their business data, their customer records, their money
    Sees: ONLY their own data
    Can export: Everything — it's their data, always
```

### Database Tables (15 tables + views)

```
TIER 1 — PLATFORM
  platform_config          → Global settings

TIER 2 — LICENSEES
  licensees                → White-label partners
  licensee_users           → Their team members

TIER 3 — CONTRACTORS
  contractors              → The small business owners
  agent_configs            → Per-agent settings (1 row per agent × 5 agents)

TIER 4 — BUSINESS DATA
  customers                → Their client database
  jobs                     → Work orders
  quotes                   → Estimates sent to customers
  invoices                 → Bills sent to customers

TIER 5 — FINANCIAL
  payments                 → Every payment received
  payouts                  → Money sent to contractor bank

TIER 6 — AI AGENT DATA
  calls                    → Every call the Receptionist handles
  documents                → All files (licenses, photos, contracts, PDFs)
  reviews                  → Google/Yelp reviews + responses
  social_posts             → Marketer agent output
  invoice_reminders        → Collector agent message history

TIER 7 — AUDIT
  activity_log             → Everything that happens, timestamped
  licensee_dashboard_stats → Materialized view for fast KPI queries
```

---

## THE PAYMENT FLOW

### Stream 1: Licensee → CrewBox
```
Licensee signs up
  → Stripe subscription created ($297/597/1497 per month)
  → 14-day free trial automatically applied
  → Auto-billing on card on file
  → Dunning handled by Stripe if payment fails
  → Subscription status synced to DB via webhook
```

### Stream 2: Customer → Contractor (via CrewBox)
```
Job completed
  → Collector agent generates invoice in DB
  → Stripe payment link created (goes to contractor's Connected Account)
  → Link sent via SMS/email to customer
  → Customer pays (card, ACH, Apple Pay, Google Pay)
  → Money flows: Customer → Stripe → Contractor bank account (1-2 days)
  → Optional: CrewBox takes 0.5% platform fee automatically
  → Stripe generates 1099-K at year end for contractor
  → Payment recorded in DB, invoice marked paid
  → Activity logged
```

### Stream 3 (Optional): Platform Revenue Share
```
0.5% of every payment processed through CrewBox
At $1M processed/month across all contractors → $5,000 passive revenue
This is separate from licensee subscription fees
Fully optional — can be set to 0%
```

---

## SECURITY ARCHITECTURE

### Layer 1: Database (Supabase RLS)
- Every table has Row Level Security enabled
- Users can ONLY see rows their role permits
- Math-level isolation — no code bug can leak data
- JWT claims (`role`, `licensee_id`, `contractor_id`) drive all policies
- Service role key (backend only) bypasses RLS for AI agent writes

### Layer 2: File Storage (AWS S3)
- All buckets are 100% private — no public access ever
- Files accessed only via pre-signed URLs that expire in 15 minutes
- AES-256 encryption at rest on every file
- TLS encryption in transit
- File paths include tenant IDs for organizational isolation
- Access logged to activity_log on every download

### Layer 3: Payments (Stripe)
- CrewBox never touches payment card data
- PCI DSS compliance handled entirely by Stripe
- Connected Accounts isolate contractor money
- Platform fees taken automatically via `application_fee_amount`

### Layer 4: Authentication
- Supabase Auth handles passwords, sessions, MFA
- Custom JWT claims set on every user at creation
- Claims read by RLS policies on every DB query
- Temp passwords for contractor login, force-change on first login

---

## THE 5 AI AGENTS — DATA THEY WRITE

### 📞 Receptionist
- Writes to: `calls`, `customers`, `jobs`, `activity_log`
- Reads from: `contractors` (business info, hours, pricing for AI training)
- Triggers: job creation, customer creation, booking confirmation SMS

### 📋 Estimator
- Writes to: `quotes`, `documents` (quote PDF), `activity_log`
- Reads from: `jobs`, `customers`, `contractors`
- Triggers: SMS/email delivery of quote, follow-up scheduling

### 💰 Collector
- Writes to: `invoices`, `invoice_reminders`, `payments`, `activity_log`
- Reads from: `jobs`, `customers`, `contractors.stripe_connect_account_id`
- Triggers: Stripe payment link creation, SMS/email reminders

### 📱 Marketer
- Writes to: `social_posts`, `documents` (photo uploads), `activity_log`
- Reads from: `jobs`, `documents` (job photos)
- Triggers: Social media API posts, scheduling

### ⭐ Rep
- Writes to: `reviews`, `activity_log`
- Reads from: `reviews` (incoming), `jobs` (for review request timing)
- Triggers: Review request SMS after job complete, Google/Yelp API responses

---

## DOCUMENT STORAGE STRUCTURE (S3)

```
crewbox-documents/
├── {licensee_id}/
│   └── {contractor_id}/
│       ├── licenses/
│       │   ├── {uuid}-contractor-license.pdf
│       │   └── {uuid}-specialty-cert.pdf
│       ├── insurance/
│       │   └── {uuid}-general-liability.pdf
│       ├── legal/
│       │   └── {uuid}-business-registration.pdf
│       ├── tax/
│       │   └── {uuid}-w9.pdf
│       ├── contracts/
│       │   └── {uuid}-signed-agreement.pdf
│       ├── invoices/
│       │   └── {uuid}-INV-2026-0042.pdf
│       └── quotes/
│           └── {uuid}-Q-2026-0019.pdf

crewbox-recordings/          ← auto-deleted after 90 days
├── {licensee_id}/
│   └── {contractor_id}/
│       └── recordings/
│           └── call-{call_id}-{timestamp}.mp3

crewbox-media/               ← job photos for social posts
├── {licensee_id}/
│   └── {contractor_id}/
│       └── job-photos/
│           ├── {uuid}-before.jpg
│           └── {uuid}-after.jpg
```

---

## PHASE 2 BUILD LIST

Now that Phase 1 is complete, Phase 2 connects the AI:

### Receptionist Agent (Vapi Integration)
```javascript
// When Vapi call comes in:
1. Look up contractor by inbound phone number
2. Load their business info, hours, pricing into Vapi prompt
3. Vapi AI answers the call
4. On hang-up: transcript + summary written to calls table
5. If booked: job record created, customer record created/updated
6. Confirmation SMS sent to caller via Twilio
```

### Estimator Agent (Claude API)
```javascript
// When contractor uploads job photo:
1. Photo stored to S3 (storage-service.js)
2. Claude Vision analyzes photo
3. Claude generates itemized quote
4. Quote saved to quotes table
5. PDF generated, stored to S3
6. Stripe payment link created for that amount
7. SMS/email sent to customer with quote
```

### Collector Agent (Scheduled)
```javascript
// Runs every morning at 6am:
1. Query invoices where status='sent' and due_date < today
2. Calculate days overdue
3. Build message (tone escalates per reminder_count)
4. Send via Twilio (SMS) or email
5. Log to invoice_reminders table
6. Update next_reminder_at on invoice
```

---

## ENVIRONMENT VARIABLES NEEDED

```bash
# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # backend only, never expose to client

# AWS S3
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
S3_BUCKET_DOCUMENTS=crewbox-documents
S3_BUCKET_RECORDINGS=crewbox-recordings
S3_BUCKET_MEDIA=crewbox-media

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_STARTER_PRICE_ID=price_...
STRIPE_GROWTH_PRICE_ID=price_...
STRIPE_ENTERPRISE_PRICE_ID=price_...

# Vapi (Phase 2)
VAPI_API_KEY=...
VAPI_PHONE_NUMBER_ID=...

# Twilio (SMS)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...

# Claude (Estimator Agent - Phase 2)
ANTHROPIC_API_KEY=sk-ant-...

# App
APP_URL=https://app.crewbox.ai
NODE_ENV=production
```

---

## MONTHLY COST BREAKDOWN

| Service | Free Tier | At 25 Clients | At 100 Clients |
|---------|-----------|----------------|-----------------|
| Supabase | Free (500MB) | $25/mo (Pro) | $25/mo |
| AWS S3 | 5GB free | ~$2/mo | ~$8/mo |
| Vapi | Pay per min | ~$50/mo | ~$200/mo |
| Twilio | $15 credit | ~$30/mo | ~$120/mo |
| Vercel (hosting) | Free | Free | $20/mo |
| Claude API | Pay per use | ~$20/mo | ~$80/mo |
| **Total** | **~$0** | **~$127/mo** | **~$453/mo** |

**Revenue at 25 clients × $400/mo = $10,000/mo**
**Profit = $10,000 - $127 - $597 (licensee fee) = ~$9,276/mo**
**Margin: 92%**
