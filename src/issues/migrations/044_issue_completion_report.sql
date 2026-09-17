-- 044_issue_completion_report: machine-readable completion evidence alongside the legacy summary.
-- Existing result_summary remains unchanged for backward compatibility.
ALTER TABLE issues ADD COLUMN completion_report_json TEXT;
