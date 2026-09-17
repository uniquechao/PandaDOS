-- 048：推理档位（reasoning effort）按模块与 issue 定档（#281 / I-04）。
--
-- 只加两列，不动 CHECK、不重建表（project_modules / issues 都挂着外键与索引，
-- 整表重建会顺带清空子表——034 之后已有一次教训）。
--
-- 两列都可空，`NULL = 继承上一层`：issue 缺省继承模块，模块缺省用控制面的默认档。
-- 取值只有 'low' | 'medium' | 'high'（codex 的 model_reasoning_effort）；合法性在写入侧
-- 校验，不加 CHECK——加了以后再扩档位就得重建表，代价远大于收益。
ALTER TABLE project_modules ADD COLUMN reasoning_effort TEXT;
ALTER TABLE issues ADD COLUMN reasoning_effort TEXT;

-- 存量模块保持 high 不变（发起人拍板）：执行机上 ~/.codex/config.toml 一直是全局 high，
-- 光加列不回填的话，所有未配置的模块会在这次发布里一次性掉到控制面默认档（medium），
-- 等于给所有在跑模块换了行为。**只回填迁移那一刻已存在的行**，之后新建的模块仍走 medium。
UPDATE project_modules SET reasoning_effort = 'high' WHERE reasoning_effort IS NULL;
