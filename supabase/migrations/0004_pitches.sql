-- bct_pitches — visitor-submitted film pitches
--
-- The landing page widget POSTs into this table directly via the
-- Supabase anon key. RLS allows anon INSERT but blocks all reads
-- and updates so the table is write-only from the public side. The
-- swarm runner reads with the service-role key, verifies the
-- payment_txid against WhatsOnChain, and on success creates a
-- corresponding bct_offers row that the producer agents pick up.
--
-- Apply with:
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" \
--     < supabase/migrations/0004_pitches.sql

CREATE TABLE IF NOT EXISTS bct_pitches (
  id              bigserial    PRIMARY KEY,
  title           text         NOT NULL,
  ticker          text         NOT NULL,
  synopsis        text         NOT NULL,
  budget_sats     bigint       NOT NULL,
  pitcher_address text,
  payment_address text         NOT NULL,
  payment_txid    text         NOT NULL,
  status          text         NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'rejected', 'converted')),
  offer_id        text         REFERENCES bct_offers (id) ON DELETE SET NULL,
  rejection_reason text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  UNIQUE (payment_txid)
);

CREATE INDEX IF NOT EXISTS bct_pitches_status_idx
  ON bct_pitches (status, created_at DESC);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
-- Anon role can INSERT pitches but cannot SELECT or UPDATE them. The
-- service role (used by the runner) bypasses RLS entirely so it can
-- read, verify, and update.

ALTER TABLE bct_pitches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bct_pitches_anon_insert" ON bct_pitches;
CREATE POLICY "bct_pitches_anon_insert"
  ON bct_pitches
  FOR INSERT
  TO anon
  WITH CHECK (
    char_length(title) BETWEEN 1 AND 200
    AND char_length(synopsis) BETWEEN 1 AND 4000
    AND char_length(ticker) BETWEEN 1 AND 16
    AND char_length(payment_txid) = 64
    AND budget_sats BETWEEN 100 AND 10000000
    AND status = 'pending'
  );
