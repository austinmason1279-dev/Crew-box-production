-- ============================================================
-- CREWBOX PLATFORM — COMPLETE DATABASE SCHEMA
-- Supabase / PostgreSQL
-- Multi-tenant: Platform → Licensees → Contractors → Customers
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE trade_type AS ENUM (
  'hvac', 'plumbing', 'electrical', 'roofing', 'general_contractor',
  'cleaning', 'landscaping', 'auto_repair', 'painting', 'flooring',
  'pest_control', 'appliance_repair', 'other'
);

CREATE TYPE subscription_tier AS ENUM ('starter', 'growth', 'enterprise');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'trialing');
CREATE TYPE agent_type AS ENUM ('receptionist', 'estimator', 'collector', 'marketer', 'rep');
CREATE TYPE agent_status AS ENUM ('active', 'paused', 'configuring');
CREATE TYPE job_status AS ENUM ('inquiry', 'quoted', 'scheduled', 'in_progress', 'completed', 'cancelled');
CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'viewed', 'paid', 'overdue', 'disputed', 'cancelled');
CREATE TYPE payment_method AS ENUM ('card', 'ach', 'apple_pay', 'google_pay', 'cash', 'check');
CREATE TYPE call_outcome AS ENUM ('booked', 'callback', 'not_interested', 'voicemail', 'wrong_number', 'transferred');
CREATE TYPE document_type AS ENUM (
  'contractor_license', 'insurance_certificate', 'business_registration',
  'w9', 'signed_contract', 'job_photo_before', 'job_photo_after',
  'invoice_pdf', 'quote_pdf', 'payment_receipt', 'other'
);
CREATE TYPE review_platform AS ENUM ('google', 'yelp', 'facebook', 'homeadvisor', 'angi', 'other');
CREATE TYPE phone_setup_type AS ENUM ('call_forward', 'ported', 'new_number');
CREATE TYPE payout_status AS ENUM ('pending', 'in_transit', 'paid', 'failed', 'cancelled');

-- ============================================================
-- TIER 1: PLATFORM (CrewBox itself)
-- ============================================================

CREATE TABLE platform_config (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key             TEXT UNIQUE NOT NULL,
  value           JSONB NOT NULL,
  description     TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed platform config
INSERT INTO platform_config (key, value, description) VALUES
  ('api_version', '"1.0.0"', 'Current API version'),
  ('max_file_size_mb', '50', 'Max file upload size in MB'),
  ('call_recording_retention_days', '90', 'Days to retain call recordings'),
  ('invoice_payment_terms_default', '30', 'Default net payment terms in days');

-- ============================================================
-- TIER 2: LICENSEES (White-label partners)
-- ============================================================

CREATE TABLE licensees (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Identity
  company_name          TEXT NOT NULL,
  slug                  TEXT UNIQUE NOT NULL,              -- used in subdomain: {slug}.crewbox.ai
  owner_name            TEXT NOT NULL,
  owner_email           TEXT UNIQUE NOT NULL,
  owner_phone           TEXT,
  -- Branding (white-label)
  brand_name            TEXT NOT NULL,                     -- what clients see
  brand_logo_url        TEXT,
  brand_primary_color   TEXT DEFAULT '#F5C800',
  brand_secondary_color TEXT DEFAULT '#111111',
  custom_domain         TEXT UNIQUE,                       -- e.g. app.protradeai.com
  -- Subscription
  stripe_customer_id    TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  subscription_tier     subscription_tier NOT NULL DEFAULT 'starter',
  subscription_status   subscription_status NOT NULL DEFAULT 'trialing',
  trial_ends_at         TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  -- Limits
  max_contractor_accounts INT NOT NULL DEFAULT 10,
  current_contractor_count INT NOT NULL DEFAULT 0,
  -- Settings
  allow_sub_licensees   BOOLEAN DEFAULT FALSE,
  revenue_share_enabled BOOLEAN DEFAULT FALSE,
  revenue_share_percent NUMERIC(4,2) DEFAULT 0,
  -- Meta
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  is_active             BOOLEAN DEFAULT TRUE
);

-- Licensee team members (staff who manage the dashboard)
CREATE TABLE licensee_users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  licensee_id   UUID NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  auth_user_id  UUID NOT NULL UNIQUE,                      -- Supabase auth.users id
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',             -- admin | staff | read_only
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- ============================================================
-- TIER 3: CONTRACTORS (The actual small business owners)
-- ============================================================

CREATE TABLE contractors (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  licensee_id             UUID NOT NULL REFERENCES licensees(id) ON DELETE RESTRICT,
  auth_user_id            UUID UNIQUE,                     -- Supabase auth.users id (optional login)
  -- Business Identity
  business_name           TEXT NOT NULL,
  owner_name              TEXT NOT NULL,
  owner_email             TEXT,
  owner_phone             TEXT NOT NULL,
  trade_type              trade_type NOT NULL,
  trade_specialty         TEXT,                            -- e.g. "residential AC, commercial HVAC"
  -- Location & Service Area
  address_street          TEXT,
  address_city            TEXT NOT NULL,
  address_state           TEXT NOT NULL,
  address_zip             TEXT,
  service_radius_miles    INT DEFAULT 25,
  service_areas           TEXT[],                          -- array of zip codes or city names
  -- Phone Setup
  phone_setup_type        phone_setup_type NOT NULL DEFAULT 'call_forward',
  ai_phone_number         TEXT,                            -- the Vapi/Twilio number CrewBox controls
  existing_phone_number   TEXT,                            -- their real business number
  vapi_phone_number_id    TEXT,                            -- Vapi internal ID
  -- Stripe (for accepting payments)
  stripe_connect_account_id TEXT UNIQUE,                   -- their Connected Account
  stripe_onboarding_complete BOOLEAN DEFAULT FALSE,
  stripe_charges_enabled  BOOLEAN DEFAULT FALSE,
  stripe_payouts_enabled  BOOLEAN DEFAULT FALSE,
  -- Subscription (what licensee charges them — managed by licensee)
  monthly_fee             NUMERIC(10,2),
  billing_day             INT DEFAULT 1,
  -- Business Details for AI training
  business_hours          JSONB DEFAULT '{"mon":"8am-6pm","tue":"8am-6pm","wed":"8am-6pm","thu":"8am-6pm","fri":"8am-6pm","sat":"closed","sun":"closed"}',
  service_area_description TEXT,
  pricing_notes           TEXT,                            -- e.g. "minimum service call $89"
  special_instructions    TEXT,                            -- e.g. "Never promise same-day, always ask for address first"
  -- License & Compliance
  contractor_license_number TEXT,
  license_expiry_date     DATE,
  license_state           TEXT,
  insurance_provider      TEXT,
  insurance_policy_number TEXT,
  insurance_expiry_date   DATE,
  -- Status & Meta
  is_active               BOOLEAN DEFAULT TRUE,
  onboarding_complete     BOOLEAN DEFAULT FALSE,
  onboarding_step         INT DEFAULT 1,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast licensee lookups
CREATE INDEX idx_contractors_licensee ON contractors(licensee_id);
CREATE INDEX idx_contractors_phone ON contractors(existing_phone_number);
CREATE INDEX idx_contractors_state ON contractors(address_state);

-- ============================================================
-- TIER 4: CUSTOMERS (The contractor's clients)
-- ============================================================

CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id   UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  -- Identity
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  -- Address (service location)
  address_street  TEXT,
  address_city    TEXT,
  address_state   TEXT,
  address_zip     TEXT,
  -- Relationship
  first_contact_date  TIMESTAMPTZ DEFAULT NOW(),
  last_contact_date   TIMESTAMPTZ,
  total_jobs          INT DEFAULT 0,
  total_spent         NUMERIC(12,2) DEFAULT 0,
  notes               TEXT,
  tags                TEXT[],
  -- Source tracking
  lead_source         TEXT,                               -- 'phone_call', 'referral', 'google', etc.
  -- Meta
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_customers_contractor ON customers(contractor_id);
CREATE INDEX idx_customers_phone ON customers(phone);

-- ============================================================
-- AI AGENTS
-- ============================================================

CREATE TABLE agent_configs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id   UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  agent_type      agent_type NOT NULL,
  status          agent_status NOT NULL DEFAULT 'configuring',
  -- Vapi config (Receptionist)
  vapi_assistant_id TEXT,
  voice_name      TEXT DEFAULT 'maya',                    -- Vapi voice
  greeting_message TEXT,
  -- Behavior settings
  settings        JSONB NOT NULL DEFAULT '{}',
  -- e.g. for receptionist: {"max_call_duration_minutes": 10, "transfer_on_keyword": ["emergency","urgent"]}
  -- e.g. for collector: {"first_reminder_days": 7, "second_reminder_days": 14, "final_reminder_days": 30}
  -- e.g. for marketer: {"post_frequency": "weekly", "platforms": ["google","facebook"]}
  -- Meta
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ,
  UNIQUE(contractor_id, agent_type)
);

CREATE INDEX idx_agent_configs_contractor ON agent_configs(contractor_id);

-- ============================================================
-- JOBS (The core work unit)
-- ============================================================

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id   UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Job Details
  title           TEXT NOT NULL,
  description     TEXT,
  trade_category  TEXT,
  status          job_status NOT NULL DEFAULT 'inquiry',
  priority        TEXT DEFAULT 'normal',                  -- low | normal | high | emergency
  -- Scheduling
  requested_date  TIMESTAMPTZ,
  scheduled_start TIMESTAMPTZ,
  scheduled_end   TIMESTAMPTZ,
  actual_start    TIMESTAMPTZ,
  actual_end      TIMESTAMPTZ,
  -- Location
  service_address TEXT,
  service_city    TEXT,
  service_zip     TEXT,
  -- Source
  source          TEXT,                                   -- 'ai_call', 'manual', 'website', 'referral'
  source_call_id  UUID,                                   -- references calls table
  -- Financial
  quoted_amount   NUMERIC(10,2),
  final_amount    NUMERIC(10,2),
  -- Notes
  internal_notes  TEXT,
  completion_notes TEXT,
  -- Meta
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_jobs_contractor ON jobs(contractor_id);
CREATE INDEX idx_jobs_customer ON jobs(customer_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled ON jobs(scheduled_start);

-- ============================================================
-- QUOTES
-- ============================================================

CREATE TABLE quotes (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id       UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Quote Details
  quote_number        TEXT NOT NULL,                      -- e.g. Q-2026-0042
  title               TEXT NOT NULL,
  description         TEXT,
  line_items          JSONB NOT NULL DEFAULT '[]',
  -- e.g. [{"description":"Labor - AC Installation","qty":1,"unit_price":450,"total":450},
  --        {"description":"Condenser Unit 3-ton","qty":1,"unit_price":1200,"total":1200}]
  subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_rate            NUMERIC(5,4) DEFAULT 0,
  tax_amount          NUMERIC(10,2) DEFAULT 0,
  discount_amount     NUMERIC(10,2) DEFAULT 0,
  total_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Status
  status              TEXT DEFAULT 'draft',               -- draft | sent | viewed | accepted | rejected | expired
  sent_at             TIMESTAMPTZ,
  viewed_at           TIMESTAMPTZ,
  accepted_at         TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  -- Delivery
  sent_via            TEXT[],                             -- ['sms', 'email']
  pdf_url             TEXT,                               -- S3 URL to generated PDF
  -- AI Generated
  ai_generated        BOOLEAN DEFAULT FALSE,
  source_photo_urls   TEXT[],                             -- photos used to generate quote
  source_voice_note_url TEXT,
  -- Meta
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_quotes_contractor ON quotes(contractor_id);
CREATE INDEX idx_quotes_job ON quotes(job_id);

-- ============================================================
-- INVOICES
-- ============================================================

CREATE TABLE invoices (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id         UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  job_id                UUID REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  quote_id              UUID REFERENCES quotes(id) ON DELETE SET NULL,
  -- Invoice Details
  invoice_number        TEXT NOT NULL,                    -- e.g. INV-2026-0099
  title                 TEXT NOT NULL,
  line_items            JSONB NOT NULL DEFAULT '[]',
  subtotal              NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_rate              NUMERIC(5,4) DEFAULT 0,
  tax_amount            NUMERIC(10,2) DEFAULT 0,
  discount_amount       NUMERIC(10,2) DEFAULT 0,
  total_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_paid           NUMERIC(10,2) DEFAULT 0,
  amount_due            NUMERIC(10,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED,
  -- Status & Dates
  status                invoice_status NOT NULL DEFAULT 'draft',
  issue_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date              DATE,
  payment_terms_days    INT DEFAULT 30,
  sent_at               TIMESTAMPTZ,
  viewed_at             TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  overdue_at            TIMESTAMPTZ,
  -- Stripe Payment
  stripe_payment_intent_id TEXT,
  stripe_payment_link_url  TEXT,
  payment_method_used   payment_method,
  -- Collection tracking
  reminder_count        INT DEFAULT 0,
  last_reminder_sent_at TIMESTAMPTZ,
  next_reminder_at      TIMESTAMPTZ,
  -- PDF
  pdf_url               TEXT,
  -- Meta
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_contractor ON invoices(contractor_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE payments (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id           UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  invoice_id              UUID REFERENCES invoices(id) ON DELETE SET NULL,
  customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Amounts
  amount                  NUMERIC(10,2) NOT NULL,
  platform_fee            NUMERIC(10,2) DEFAULT 0,        -- CrewBox cut (optional)
  stripe_fee              NUMERIC(10,2) DEFAULT 0,
  net_amount              NUMERIC(10,2),                  -- what contractor actually receives
  currency                TEXT DEFAULT 'usd',
  -- Stripe
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id        TEXT,
  stripe_transfer_id      TEXT,
  payment_method          payment_method,
  -- Status
  status                  TEXT DEFAULT 'pending',         -- pending | succeeded | failed | refunded
  paid_at                 TIMESTAMPTZ,
  refunded_at             TIMESTAMPTZ,
  refund_amount           NUMERIC(10,2),
  refund_reason           TEXT,
  -- Meta
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_contractor ON payments(contractor_id);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);

-- ============================================================
-- PAYOUTS (Contractor receiving money to their bank)
-- ============================================================

CREATE TABLE payouts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id         UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  stripe_payout_id      TEXT UNIQUE,
  amount                NUMERIC(10,2) NOT NULL,
  currency              TEXT DEFAULT 'usd',
  status                payout_status NOT NULL DEFAULT 'pending',
  arrival_date          DATE,
  bank_last_four        TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CALLS (Receptionist Agent Logs)
-- ============================================================

CREATE TABLE calls (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id       UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Vapi Data
  vapi_call_id        TEXT UNIQUE,
  -- Call Details
  caller_phone        TEXT,
  caller_name         TEXT,
  direction           TEXT DEFAULT 'inbound',             -- inbound | outbound
  duration_seconds    INT,
  outcome             call_outcome,
  -- Content
  transcript          TEXT,
  summary             TEXT,                               -- AI summary of the call
  recording_url       TEXT,                               -- S3 URL (encrypted)
  recording_expires_at TIMESTAMPTZ,
  -- Job Created
  job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
  appointment_booked  BOOLEAN DEFAULT FALSE,
  -- Transfer
  transferred_to      TEXT,
  transfer_reason     TEXT,
  -- AI Confidence
  ai_confidence_score NUMERIC(3,2),                      -- 0.00-1.00
  required_human_followup BOOLEAN DEFAULT FALSE,
  -- Meta
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_calls_contractor ON calls(contractor_id);
CREATE INDEX idx_calls_started_at ON calls(started_at);
CREATE INDEX idx_calls_outcome ON calls(outcome);

-- ============================================================
-- DOCUMENTS (Licenses, Contracts, Photos, etc.)
-- ============================================================

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id   UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  -- File Info
  document_type   document_type NOT NULL,
  file_name       TEXT NOT NULL,
  file_size_bytes BIGINT,
  mime_type       TEXT,
  -- S3 Storage
  s3_bucket       TEXT NOT NULL DEFAULT 'crewbox-documents',
  s3_key          TEXT NOT NULL UNIQUE,
  -- e.g. /{licensee_id}/{contractor_id}/licenses/contractor-license-2026.pdf
  -- Access
  is_private      BOOLEAN DEFAULT TRUE,
  -- Compliance
  expiry_date     DATE,                                   -- for licenses, insurance certs
  is_verified     BOOLEAN DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  verified_by     TEXT,
  -- Meta
  description     TEXT,
  tags            TEXT[],
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_documents_contractor ON documents(contractor_id);
CREATE INDEX idx_documents_type ON documents(document_type);
CREATE INDEX idx_documents_expiry ON documents(expiry_date);

-- ============================================================
-- REVIEWS (Reputation Management)
-- ============================================================

CREATE TABLE reviews (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id       UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Review Data
  platform            review_platform NOT NULL,
  external_review_id  TEXT,                               -- the ID on Google/Yelp etc.
  reviewer_name       TEXT,
  rating              INT CHECK (rating BETWEEN 1 AND 5),
  review_text         TEXT,
  review_date         TIMESTAMPTZ,
  -- Response
  response_text       TEXT,
  responded_at        TIMESTAMPTZ,
  ai_generated_response BOOLEAN DEFAULT FALSE,
  response_approved   BOOLEAN DEFAULT FALSE,              -- licensee/contractor approval before posting
  -- Request Sent
  request_sent_at     TIMESTAMPTZ,
  request_sent_via    TEXT,                               -- 'sms' | 'email'
  job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
  -- Meta
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reviews_contractor ON reviews(contractor_id);
CREATE INDEX idx_reviews_platform ON reviews(platform);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- ============================================================
-- SOCIAL POSTS (Marketer Agent)
-- ============================================================

CREATE TABLE social_posts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id     UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  job_id            UUID REFERENCES jobs(id) ON DELETE SET NULL,
  -- Content
  caption           TEXT NOT NULL,
  image_urls        TEXT[],
  hashtags          TEXT[],
  -- Platforms
  platforms         TEXT[] NOT NULL,                      -- ['google_business','facebook','instagram']
  -- Status per platform stored as JSONB
  -- e.g. {"google_business": "posted", "facebook": "failed", "instagram": "scheduled"}
  platform_status   JSONB DEFAULT '{}',
  platform_post_ids JSONB DEFAULT '{}',                   -- external post IDs per platform
  -- Scheduling
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  -- AI
  ai_generated      BOOLEAN DEFAULT TRUE,
  -- Metrics
  total_views       INT DEFAULT 0,
  total_likes       INT DEFAULT 0,
  -- Meta
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_social_posts_contractor ON social_posts(contractor_id);

-- ============================================================
-- INVOICE REMINDERS (Collector Agent Automation)
-- ============================================================

CREATE TABLE invoice_reminders (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  -- Reminder
  reminder_number INT NOT NULL,                           -- 1, 2, 3...
  tone          TEXT DEFAULT 'friendly',                  -- friendly | firm | final
  channel       TEXT NOT NULL,                            -- 'sms' | 'email'
  message_body  TEXT NOT NULL,
  -- Status
  sent_at       TIMESTAMPTZ,
  delivered     BOOLEAN DEFAULT FALSE,
  opened        BOOLEAN DEFAULT FALSE,
  -- Result
  payment_triggered BOOLEAN DEFAULT FALSE,                -- did this reminder result in payment?
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reminders_invoice ON invoice_reminders(invoice_id);

-- ============================================================
-- ACTIVITY LOG (Audit trail for everything)
-- ============================================================

CREATE TABLE activity_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id   UUID REFERENCES contractors(id) ON DELETE SET NULL,
  licensee_id     UUID REFERENCES licensees(id) ON DELETE SET NULL,
  -- What happened
  agent           TEXT,                                   -- which AI agent, or 'system', 'user'
  action          TEXT NOT NULL,                          -- 'call_answered', 'invoice_sent', etc.
  entity_type     TEXT,                                   -- 'call', 'invoice', 'job', etc.
  entity_id       UUID,
  description     TEXT NOT NULL,
  amount          NUMERIC(10,2),                          -- if financial event
  metadata        JSONB DEFAULT '{}',
  -- Meta
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activity_contractor ON activity_log(contractor_id);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX idx_activity_agent ON activity_log(agent);

-- ============================================================
-- PLATFORM ANALYTICS (Licensee Dashboard KPIs)
-- ============================================================

-- Materialized view for fast dashboard queries
CREATE MATERIALIZED VIEW licensee_dashboard_stats AS
SELECT
  c.licensee_id,
  COUNT(DISTINCT c.id)                                    AS total_contractors,
  COUNT(DISTINCT c.id) FILTER (WHERE c.is_active = TRUE) AS active_contractors,
  COUNT(DISTINCT ca.id) FILTER (WHERE ca.status = 'active') AS active_agents,
  COUNT(DISTINCT cl.id)                                   AS total_calls_this_month,
  COUNT(DISTINCT cl.id) FILTER (WHERE cl.appointment_booked = TRUE) AS calls_booked_this_month,
  COALESCE(SUM(p.amount) FILTER (WHERE p.created_at >= DATE_TRUNC('month', NOW())), 0) AS revenue_processed_this_month,
  COALESCE(SUM(i.total_amount) FILTER (WHERE i.status = 'overdue'), 0) AS total_overdue,
  AVG(r.rating)                                           AS avg_review_rating
FROM contractors c
LEFT JOIN agent_configs ca ON ca.contractor_id = c.id
LEFT JOIN calls cl ON cl.contractor_id = c.id AND cl.started_at >= DATE_TRUNC('month', NOW())
LEFT JOIN payments p ON p.contractor_id = c.id AND p.status = 'succeeded'
LEFT JOIN invoices i ON i.contractor_id = c.id
LEFT JOIN reviews r ON r.contractor_id = c.id
GROUP BY c.licensee_id;

CREATE UNIQUE INDEX ON licensee_dashboard_stats(licensee_id);

-- Refresh function (call via pg_cron or Supabase Edge Function)
CREATE OR REPLACE FUNCTION refresh_dashboard_stats()
RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY licensee_dashboard_stats;
$$;

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Apply to all tables with updated_at
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'licensees','licensee_users','contractors','customers',
    'agent_configs','jobs','quotes','invoices','reviews','social_posts'
  ] LOOP
    EXECUTE format('
      CREATE TRIGGER set_updated_at
      BEFORE UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()
    ', t);
  END LOOP;
END;
$$;

-- Auto-generate invoice numbers
CREATE OR REPLACE FUNCTION generate_invoice_number(contractor UUID)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  count INT;
  year TEXT;
BEGIN
  year := TO_CHAR(NOW(), 'YYYY');
  SELECT COUNT(*) + 1 INTO count FROM invoices WHERE contractor_id = contractor;
  RETURN 'INV-' || year || '-' || LPAD(count::TEXT, 4, '0');
END;
$$;

-- Auto-generate quote numbers
CREATE OR REPLACE FUNCTION generate_quote_number(contractor UUID)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  count INT;
  year TEXT;
BEGIN
  year := TO_CHAR(NOW(), 'YYYY');
  SELECT COUNT(*) + 1 INTO count FROM quotes WHERE contractor_id = contractor;
  RETURN 'Q-' || year || '-' || LPAD(count::TEXT, 4, '0');
END;
$$;

-- Update contractor count on licensee when contractor added/removed
CREATE OR REPLACE FUNCTION update_licensee_contractor_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE licensees SET current_contractor_count = current_contractor_count + 1
    WHERE id = NEW.licensee_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE licensees SET current_contractor_count = current_contractor_count - 1
    WHERE id = OLD.licensee_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contractor_count_trigger
AFTER INSERT OR DELETE ON contractors
FOR EACH ROW EXECUTE FUNCTION update_licensee_contractor_count();

-- Update customer stats when job completed + paid
CREATE OR REPLACE FUNCTION update_customer_stats()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'succeeded' AND OLD.status != 'succeeded' THEN
    UPDATE customers SET
      total_jobs = total_jobs + 1,
      total_spent = total_spent + NEW.amount,
      last_contact_date = NOW()
    WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_stats_trigger
AFTER UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION update_customer_stats();
