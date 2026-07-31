-- 011_project_members: 项目↔用户 多对多关联（协作成员）。
--   project_id  所属项目（删项目级联清理）。
--   user_id     被关联的用户（删用户级联清理）。
--   created_ts  加入时刻（epoch 毫秒）。
-- 语义：项目仍有单一属主 projects.owner_user_id（不进本表）；本表登记「额外协作成员」。
--   访问口径 = 属主 ∨ 本表成员 ∨ admin（见 middleware 'project-access'）；成员可对 issue
--   做全部操作，项目级管理（改设置/增删成员/归档删除/转属主）仍限属主与 admin。
--   主键 (project_id, user_id) 天然去重，同一人对同一项目至多一条成员记录。
--   PK 前缀已覆盖「按项目列成员」；另建 user_id 索引支撑「按用户列其参与的项目」。

CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_project_members_user ON project_members(user_id);
