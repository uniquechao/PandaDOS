-- Preserve existing planned issues; new issues opt into direct execution in the engine.
ALTER TABLE issues ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'planned' CHECK (execution_mode IN ('direct', 'planned'));
