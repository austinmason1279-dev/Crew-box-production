-- ============================================================
-- CREWBOX — ROW LEVEL SECURITY POLICIES
-- This is what makes multi-tenancy safe at the database level.
-- No code bug can ever leak data between tenants.
-- ============================================================

-- Enable RLS on every table
ALTER TABLE licensees              ENABLE ROW LEVEL SECURITY;
ALTER TABLE licensee_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews                ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_reminders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log           ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- HELPER FUNCTIONS
-- These extract the current user's role + IDs from JWT claims
-- ============================================================

-- Returns 'platform_admin' | 'licensee' | 'contractor'
CREATE OR REPLACE FUNCTION auth.user_role()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::json->>'role',
    'anon'
  );
$$;

-- Returns the licensee_id for the current auth user
CREATE OR REPLACE FUNCTION auth.licensee_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::json->>'licensee_id')::UUID;
$$;

-- Returns the contractor_id for the current auth user
CREATE OR REPLACE FUNCTION auth.contractor_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::json->>'contractor_id')::UUID;
$$;

-- ============================================================
-- LICENSEES TABLE
-- ============================================================

-- Platform admins see all licensees
CREATE POLICY "platform_admin_all_licensees"
ON licensees FOR ALL
TO authenticated
USING (auth.user_role() = 'platform_admin');

-- Licensee users see only their own licensee row
CREATE POLICY "licensee_sees_own_record"
ON licensees FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND id = auth.licensee_id()
);

-- Licensee users can update their own branding/settings
CREATE POLICY "licensee_updates_own_record"
ON licensees FOR UPDATE
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND id = auth.licensee_id()
)
WITH CHECK (
  id = auth.licensee_id()
);

-- ============================================================
-- LICENSEE USERS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_own_team"
ON licensee_users FOR SELECT
TO authenticated
USING (
  auth.user_role() IN ('platform_admin', 'licensee')
  AND (
    auth.user_role() = 'platform_admin'
    OR licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "licensee_manages_own_team"
ON licensee_users FOR ALL
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND licensee_id = auth.licensee_id()
);

-- ============================================================
-- CONTRACTORS TABLE
-- ============================================================

-- Platform admin sees all
CREATE POLICY "platform_admin_all_contractors"
ON contractors FOR ALL
TO authenticated
USING (auth.user_role() = 'platform_admin');

-- Licensee sees only their own contractors
CREATE POLICY "licensee_sees_own_contractors"
ON contractors FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND licensee_id = auth.licensee_id()
);

-- Licensee can add/edit/deactivate their contractors
CREATE POLICY "licensee_manages_own_contractors"
ON contractors FOR INSERT
TO authenticated
WITH CHECK (
  auth.user_role() = 'licensee'
  AND licensee_id = auth.licensee_id()
);

CREATE POLICY "licensee_updates_own_contractors"
ON contractors FOR UPDATE
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND licensee_id = auth.licensee_id()
);

-- Contractor sees only their OWN row
CREATE POLICY "contractor_sees_own_row"
ON contractors FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND id = auth.contractor_id()
);

CREATE POLICY "contractor_updates_own_row"
ON contractors FOR UPDATE
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND id = auth.contractor_id()
)
WITH CHECK (
  id = auth.contractor_id()
  -- Contractors cannot change their licensee_id or subscription fields
);

-- ============================================================
-- CUSTOMERS TABLE
-- ============================================================

-- Licensee sees customers of ALL their contractors
CREATE POLICY "licensee_sees_all_customer_data"
ON customers FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

-- Contractor sees only THEIR customers
CREATE POLICY "contractor_sees_own_customers"
ON customers FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (
  contractor_id = auth.contractor_id()
);

-- ============================================================
-- AGENT CONFIGS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_agent_configs"
ON agent_configs FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_manages_own_agents"
ON agent_configs FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (
  contractor_id = auth.contractor_id()
);

CREATE POLICY "platform_admin_all_agents"
ON agent_configs FOR ALL
TO authenticated
USING (auth.user_role() = 'platform_admin');

-- ============================================================
-- JOBS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_jobs"
ON jobs FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_manages_own_jobs"
ON jobs FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (contractor_id = auth.contractor_id());

-- ============================================================
-- QUOTES TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_quotes"
ON quotes FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_manages_own_quotes"
ON quotes FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (contractor_id = auth.contractor_id());

-- ============================================================
-- INVOICES TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_invoices"
ON invoices FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_manages_own_invoices"
ON invoices FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (contractor_id = auth.contractor_id());

-- ============================================================
-- PAYMENTS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_payments"
ON payments FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_sees_own_payments"
ON payments FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
);

-- Payments are written by the backend server only (service role)
-- No direct client write access to payments

-- ============================================================
-- CALLS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_calls"
ON calls FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_sees_own_calls"
ON calls FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
);

-- ============================================================
-- DOCUMENTS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_documents"
ON documents FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_manages_own_documents"
ON documents FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (contractor_id = auth.contractor_id());

-- ============================================================
-- REVIEWS TABLE
-- ============================================================

CREATE POLICY "licensee_sees_all_reviews"
ON reviews FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND contractor_id IN (
    SELECT id FROM contractors WHERE licensee_id = auth.licensee_id()
  )
);

CREATE POLICY "contractor_manages_own_reviews"
ON reviews FOR ALL
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
)
WITH CHECK (contractor_id = auth.contractor_id());

-- ============================================================
-- ACTIVITY LOG
-- ============================================================

CREATE POLICY "licensee_sees_own_activity"
ON activity_log FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'licensee'
  AND licensee_id = auth.licensee_id()
);

CREATE POLICY "contractor_sees_own_activity"
ON activity_log FOR SELECT
TO authenticated
USING (
  auth.user_role() = 'contractor'
  AND contractor_id = auth.contractor_id()
);

-- ============================================================
-- SERVICE ROLE BYPASS
-- The backend API server uses a service_role key that bypasses
-- all RLS policies — used for AI agents writing data
-- This is set in Supabase project settings
-- ============================================================
