-- A consumer may only acknowledge the generation it actually projected.
ALTER TABLE project_data_outbox
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
