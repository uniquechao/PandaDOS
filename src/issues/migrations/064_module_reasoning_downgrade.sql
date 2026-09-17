-- 064：存量模块推理档位逐个下调（#294，承接 #281 / I-04）。
--
-- 048 为了不让所有在跑模块在那次发布里一次性掉档，把**当时已存在的**模块统一回填成 'high'。
-- 结果是机制上线了、收益一点没吃到：46 个存量模块全是 high，而绝大多数（UI、普通后端、
-- 文档生成）根本用不着最高档推理。本条按风险逐个重判，把非高风险的降到 'medium'。
--
-- 判定规则（命中 slug 或 display_name 任一即算命中，中英双语；口径来自 #281 的分档建议）：
--   保持 high —— 迁移/schema、引擎/调度/状态机、并发/恢复、架构/框架、部署/发布/publish。
--     前四类是 #281 明确点名的高风险面（改错的代价是数据损坏、状态机死锁、恢复路径失效）；
--     部署/发布类归进来是因为它的误操作同样不可逆（推到生产、推到公开仓库收不回来）。
--   其余一律 medium —— 普通后端与 UI。
--   low 不在这里出现：按 #281 的结论，low 只留给澄清/模块整理/执行总结这类一次性会话，
--     由 core/reasoning 的 ONE_SHOT_REASONING_EFFORT 统一管，模块档不掺和。
--
-- 两条保守边界，别去掉：
--   1. **只改当前值恰为 'high' 的行**。048 的回填与「用户后来手动设成 high」在数据上分不开，
--      但用户手动设成 low/medium 的是能分开的——那是明确的人工决定，这条迁移不许覆盖。
--   2. **不动 issues.reasoning_effort**。它全是 NULL（= 继承模块），继承链本身就是对的；
--      往 issue 上写死档位只会让以后调模块档失效。
--
-- 用关键词规则而不是硬编码本机那 46 个 slug：模块名是各部署自己起的，硬编码既对别的部署
-- 毫无意义，也会把私有模块清单固化进仓库。规则命中不准的个别模块，UI 上单独改一下即可。
--
-- 只有 codex 吃 model_reasoning_effort（core/reasoning 的能力位），claude 模块这一列改了
-- 只影响界面显示、不影响行为；这里仍一并处理，免得 UI 上留着一堆名不副实的 high。
UPDATE project_modules
   SET reasoning_effort = 'medium'
 WHERE reasoning_effort = 'high'
   AND lower(slug || ' ' || display_name) NOT LIKE '%migrat%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%schema%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%engine%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%schedul%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%state machine%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%state-machine%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%statemachine%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%concurren%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%recover%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%architect%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%framework%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%deploy%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%release%'
   AND lower(slug || ' ' || display_name) NOT LIKE '%publish%'
   AND slug || ' ' || display_name NOT LIKE '%迁移%'
   AND slug || ' ' || display_name NOT LIKE '%架构%'
   AND slug || ' ' || display_name NOT LIKE '%引擎%'
   AND slug || ' ' || display_name NOT LIKE '%调度%'
   AND slug || ' ' || display_name NOT LIKE '%状态机%'
   AND slug || ' ' || display_name NOT LIKE '%并发%'
   AND slug || ' ' || display_name NOT LIKE '%恢复%'
   AND slug || ' ' || display_name NOT LIKE '%框架%'
   AND slug || ' ' || display_name NOT LIKE '%部署%'
   AND slug || ' ' || display_name NOT LIKE '%发布%';
