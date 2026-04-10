-- bMovies persistent registry schema
--
-- Runs against the existing self-hosted Supabase on Hetzner. Safe
-- to re-apply because every statement uses IF NOT EXISTS. Apply with:
--
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" \
--     < supabase/migrations/0001_init.sql
--
-- The tables persist state that currently lives only in the in-
-- memory MemoryRegistry so the swarm can survive restarts and the
-- public /productions viewer can read from a real database instead
-- of guessing at the live swarm's private state.

-- ---------------------------------------------------------------------
-- bct_offers — production offers posted by producer agents
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bct_offers (
  id                text          PRIMARY KEY,
  producer_id       text          NOT NULL,
  producer_address  text          NOT NULL,
  title             text          NOT NULL,
  synopsis          text          NOT NULL,
  required_sats     bigint        NOT NULL,
  raised_sats       bigint        NOT NULL DEFAULT 0,
  status            text          NOT NULL DEFAULT 'open',
  token_ticker      text          NOT NULL,
  presale_txid      text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bct_offers_status_idx
  ON bct_offers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS bct_offers_producer_idx
  ON bct_offers (producer_id, created_at DESC);

-- ---------------------------------------------------------------------
-- bct_subscriptions — individual financier positions in an offer
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bct_subscriptions (
  id           bigserial     PRIMARY KEY,
  offer_id     text          NOT NULL REFERENCES bct_offers (id) ON DELETE CASCADE,
  agent_id     text          NOT NULL,
  address      text          NOT NULL,
  sats         bigint        NOT NULL,
  payment_txid text,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (offer_id, agent_id)
);

CREATE INDEX IF NOT EXISTS bct_subscriptions_offer_idx
  ON bct_subscriptions (offer_id);

-- ---------------------------------------------------------------------
-- bct_artifacts — generated content attached to a funded offer
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bct_artifacts (
  id            bigserial     PRIMARY KEY,
  offer_id      text          NOT NULL REFERENCES bct_offers (id) ON DELETE CASCADE,
  kind          text          NOT NULL CHECK (kind IN ('image', 'video', 'text')),
  url           text          NOT NULL,
  model         text          NOT NULL,
  prompt        text          NOT NULL,
  payment_txid  text          NOT NULL,
  created_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bct_artifacts_offer_idx
  ON bct_artifacts (offer_id);
CREATE INDEX IF NOT EXISTS bct_artifacts_recent_idx
  ON bct_artifacts (created_at DESC);

-- ---------------------------------------------------------------------
-- Trigger to keep bct_offers.updated_at fresh
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bct_touch_offer_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bct_offers_touch_updated_at ON bct_offers;
CREATE TRIGGER bct_offers_touch_updated_at
  BEFORE UPDATE ON bct_offers
  FOR EACH ROW
  EXECUTE FUNCTION bct_touch_offer_updated_at();
