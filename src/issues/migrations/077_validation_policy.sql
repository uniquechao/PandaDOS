-- Existing projects retain the historical optional policy. New projects may require
-- a validation result or explicitly opt out without overloading an empty command list.
ALTER TABLE projects ADD COLUMN validation_policy TEXT NOT NULL DEFAULT 'optional'
  CHECK (validation_policy IN ('required', 'optional', 'none'));
