-- Atomic raised_sats increment for bct_offers.
--
-- The runner's SupabaseRegistry was doing:
--   1. read raised_sats from in-memory cache
--   2. add the new subscription locally
--   3. UPDATE bct_offers SET raised_sats = <new_total>
--
-- When two financiers tick concurrently this loses updates because
-- both writers compute their new total against the SAME starting
-- value and the second UPDATE overwrites the first. This function
-- replaces the racy UPDATE with a single atomic SQL statement that
-- adds delta_sats to the current row value and flips status to
-- 'funded' once the threshold is hit. Call via:
--
--   await supabase.rpc('bct_increment_raised_sats',
--     { p_offer_id: offerId, p_delta_sats: sats });
--
-- Apply with:
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" \
--     < supabase/migrations/0005_atomic_raised_sats.sql

CREATE OR REPLACE FUNCTION bct_increment_raised_sats(
  p_offer_id text,
  p_delta_sats bigint
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_total bigint;
BEGIN
  UPDATE bct_offers
     SET raised_sats = raised_sats + p_delta_sats,
         status = CASE
                    WHEN raised_sats + p_delta_sats >= required_sats
                      THEN 'funded'
                    ELSE status
                  END
   WHERE id = p_offer_id
  RETURNING raised_sats INTO v_new_total;

  RETURN v_new_total;
END;
$$;
