-- Phase 2: add a role column to bct_artifacts so productions
-- commissioned by a *team* of agents (director, writer, storyboard
-- artist, composer) can attach distinct artifact rows per role.
--
-- Safe to re-apply: column default is NULL so existing rows are
-- untouched, and IF NOT EXISTS prevents duplicate additions.
--
-- Apply via:
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" \
--     < supabase/migrations/0002_artifact_role.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bct_artifacts' AND column_name = 'role'
  ) THEN
    ALTER TABLE bct_artifacts
      ADD COLUMN role text;
  END IF;
END $$;

-- Index so the productions viewer can pull artifacts grouped by role
-- per offer without a full scan.
CREATE INDEX IF NOT EXISTS bct_artifacts_offer_role_idx
  ON bct_artifacts (offer_id, role);
