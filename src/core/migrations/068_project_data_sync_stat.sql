-- 068_project_data_sync_stat: 给 .panda 同步索引记下文件的 size/mtime，让「没变」不必再读全文。
--
-- 之前判断「这个协作文件变没变」的唯一判据是内容指纹，而指纹要读完整个文件才算得出来：
-- 5 秒一轮的轮询于是把全部协作文件（含 .panda/uploads 里几十 MB 的图片附件）整体重读重哈希一遍，
-- 只为得出「一个字节都没变」。记下执行机侧的 size + mtime 后，绝大多数轮次只剩一次 stat。
--
-- 两列都可空：老行没有这份元数据，读到 NULL 就退回原来的全量读，不会误判成「没变」。

ALTER TABLE project_data_sync_entries ADD COLUMN size INTEGER;
ALTER TABLE project_data_sync_entries ADD COLUMN mtime_ms INTEGER;
