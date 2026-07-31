-- 033_issue_clarify_summary: 创建时澄清反馈 + 执行结果总结
-- issues.clarify_feedback：新建 issue 后，执行代理（claude/codex）读代码库+需求给出的
--   「反馈」文本（对需求的理解/初步思路/风险）；NULL = 尚未分析或分析失败。
--   澄清问题本身仍走 issue_events（kind=clarify_questions），不入列。
-- issues.result_summary：issue 收尾（done/blocked）时，驱动它的执行代理产出的
--   执行结果总结（做了什么/改动文件/测试情况/遗留事项）；NULL = 尚未总结或总结失败。
-- 存量行默认 NULL，向后兼容。
ALTER TABLE issues ADD COLUMN clarify_feedback TEXT;
ALTER TABLE issues ADD COLUMN result_summary TEXT;
