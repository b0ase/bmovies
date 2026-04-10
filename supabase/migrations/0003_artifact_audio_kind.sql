-- Phase 2: extend bct_artifacts.kind check constraint to include
-- 'audio' so the ComposerAgent can store real audio URLs from
-- BSVAPI's /api/v1/music/generate endpoint.
--
-- Safe to re-apply: drops the old constraint by its known name,
-- then adds a new one with the extended value set.

ALTER TABLE bct_artifacts
  DROP CONSTRAINT IF EXISTS bct_artifacts_kind_check;

ALTER TABLE bct_artifacts
  ADD CONSTRAINT bct_artifacts_kind_check
  CHECK (kind IN ('image', 'video', 'text', 'audio'));
