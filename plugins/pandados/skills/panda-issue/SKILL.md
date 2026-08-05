---
name: panda-issue
description: Use whenever working on an issue or module in a repository containing .panda/modules/INDEX.md, or when a prompt provides a PandaDOS module or issue process-page path.
---

# PandaDOS Issue 模块记忆（panda 自动生成）

1. 从当前工作目录向上定位项目根目录，先读 `.panda/modules/INDEX.md`。
2. 读取当前模块的 `MODULE.md`，再读 prompt 指定的 issue 过程页。
3. 实施中只记录关键设计、决策、文件和测试，不写逐条终端流水。
4. 完成前更新 issue 过程页；只有长期仍有效的知识才提炼回 `MODULE.md`。
5. 不自行批量创建模块。文档身份、数据库事实和代码冲突时停止写入并明确报告。
