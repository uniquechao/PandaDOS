-- 046：模块级技能挂载（#277 / I-02）。
--
-- 只加一列，不动 CHECK、不重建表：project_modules 上挂着 issues.module_id 等外键，
-- 整表重建会顺带把子表清空（034 之后已有一次教训），这里没有任何需要改约束的理由。
--
-- 语义：NULL / 缺省 = 未配置，沿用项目默认（superpowers 一类默认不挂，需显式开启）；
-- 存 JSON 数组 = 该模块显式指定要挂哪些技能，空数组 = 显式一个都不挂。
ALTER TABLE project_modules ADD COLUMN skills_json TEXT;
