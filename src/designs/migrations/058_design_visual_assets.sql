-- 058_design_visual_assets: durable, idempotent visual-reference jobs and controlled output metadata.
-- Existing 050 rows remain readable; closed lifecycle enforcement belongs to DesignAssetStore.

ALTER TABLE design_assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'raster_reference';
ALTER TABLE design_assets ADD COLUMN preset TEXT;
ALTER TABLE design_assets ADD COLUMN size TEXT;
ALTER TABLE design_assets ADD COLUMN request_key TEXT;
ALTER TABLE design_assets ADD COLUMN request_digest TEXT;
ALTER TABLE design_assets ADD COLUMN asset_version INTEGER NOT NULL DEFAULT 0 CHECK (asset_version >= 0);
ALTER TABLE design_assets ADD COLUMN byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0);
ALTER TABLE design_assets ADD COLUMN output_sha256 TEXT;
ALTER TABLE design_assets ADD COLUMN implementation_ready INTEGER NOT NULL DEFAULT 0
  CHECK (implementation_ready IN (0, 1));
ALTER TABLE design_assets ADD COLUMN functional_details_json TEXT;
ALTER TABLE design_assets ADD COLUMN retry_of_asset_id INTEGER
  REFERENCES design_assets(id) ON DELETE RESTRICT;
ALTER TABLE design_assets ADD COLUMN provider_request_id TEXT;
ALTER TABLE design_assets ADD COLUMN runnable INTEGER NOT NULL DEFAULT 0 CHECK (runnable IN (0, 1));
ALTER TABLE design_assets ADD COLUMN staging_manifest_json TEXT;
ALTER TABLE design_assets ADD COLUMN provider_prompt TEXT;
ALTER TABLE design_assets ADD COLUMN prompt_compiler_version INTEGER;
ALTER TABLE design_assets ADD COLUMN include_revision_context INTEGER NOT NULL DEFAULT 0
  CHECK (include_revision_context IN (0, 1));
ALTER TABLE design_assets ADD COLUMN context_sha256 TEXT;
ALTER TABLE design_assets ADD COLUMN reference_manifest_json TEXT;
ALTER TABLE design_assets ADD COLUMN provider_model TEXT;
ALTER TABLE design_assets ADD COLUMN output_format TEXT;
ALTER TABLE design_assets ADD COLUMN quality TEXT;
ALTER TABLE design_assets ADD COLUMN expected_output_sha256 TEXT;
ALTER TABLE design_assets ADD COLUMN expected_byte_size INTEGER;
ALTER TABLE design_assets ADD COLUMN expected_mime_type TEXT;
ALTER TABLE design_assets ADD COLUMN expected_width INTEGER;
ALTER TABLE design_assets ADD COLUMN expected_height INTEGER;
ALTER TABLE design_assets ADD COLUMN ready_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE design_assets ADD COLUMN ready_ts INTEGER;

CREATE UNIQUE INDEX idx_design_assets_request_key
  ON design_assets(design_task_id, request_key)
  WHERE request_key IS NOT NULL;

CREATE INDEX idx_design_assets_queue
  ON design_assets(status, runnable, created_ts, id);

CREATE INDEX idx_design_assets_retry
  ON design_assets(retry_of_asset_id, id);
