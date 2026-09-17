-- 062：用量单价表（#282 / Q2）。
--
-- 编号避开 05x/06x：那两段分别被 designs（050-061）与 notify（060）占了。
-- **迁移编号是全局账本（schema_migrations）**，撞号的那一条会被当成「已应用」直接跳过，
-- 后果是整条链的表凭空消失——本条实施时用 050 撞了 designs，283 个用例当场变红。
--
-- 发起人拍板：金额要折算，**单价后台可配、不许写死在代码里**——单价随模型与套餐变，
-- 写死只会给出一个看起来精确的错数。单行表（id=1），与 llm_config 同款形态。
--
-- 口径：每百万 token 的美元价。初值按 gpt-5 档（新输入 $1.25/M、缓存 $0.125/M、输出 $10/M）。
-- reasoning 默认 0：推理 token **本来就含在 output 里**（claude 的 thinking_tokens、
-- codex 的 reasoning_output_tokens 都是 output 的子集），单独再收一遍就是重复计费；
-- 留这个字段只是为了将来真出现单独计价时不必再动表。
CREATE TABLE usage_pricing (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  currency              TEXT NOT NULL DEFAULT 'USD',
  input_per_mtok        REAL NOT NULL,
  cached_input_per_mtok REAL NOT NULL,
  output_per_mtok       REAL NOT NULL,
  reasoning_per_mtok    REAL NOT NULL DEFAULT 0,
  updated_ts            INTEGER NOT NULL
);

INSERT INTO usage_pricing
  (id, currency, input_per_mtok, cached_input_per_mtok, output_per_mtok, reasoning_per_mtok, updated_ts)
VALUES (1, 'USD', 1.25, 0.125, 10.0, 0, 0);
