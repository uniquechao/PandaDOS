/**
 * web/routes/uploads —— 任务截图上传（子任务10；v1 web.ts /api/issue-image 平移改造）。
 *
 * POST /api/projects/:projectId/upload：multipart（file 字段），≤5MB，仅白名单图片类型
 * （png/jpg/jpeg/gif/webp）。落盘经 Driver.writeFile 到项目 cwd/.mando/uploads/<随机子目录>/，
 * git exclude 经 Driver 读写（core/uploads.ts）。
 *
 * 返回 { ok, path: rel, abs, name, size }（与 v1 响应形状一致）：
 * 前端拿 rel 随建 issue 的 images 一起提交 → 存 issues.images_json（相对 cwd 路径数组，
 * 与 v1 约定一致；引擎 absImages+imageReadHint 拼执行机绝对路径喂 prompt）。
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import { safeImageName, saveUploadImage, type UploadFs } from '../../core/uploads';
import { getProject } from '../../issues/engine';
import { json, type RouteDef } from '../middleware';

/** 单张截图大小上限（v1 是 12MB；v2 收紧为 5MB，评审 [M11] 上传无上限教训的反向收口） */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** multipart 组帧开销余量（boundary/头部），用于 Content-Length 先行拦截 */
const MULTIPART_OVERHEAD = 64 * 1024;

export interface UploadsRoutesDeps {
  db: Database;
  /** 项目所在执行机的 Driver（SshDriver/LocalDriver 均可，结构兼容 UploadFs） */
  driver: UploadFs;
}

export function uploadsRoutes(deps: UploadsRoutesDeps): RouteDef[] {
  const { db, driver } = deps;
  return [
    {
      method: 'POST',
      path: '/api/projects/:projectId/upload',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);

        // 声明长度先挡一刀——超大 body 不进 formData 全量缓冲（评审 [M11] 教训）
        const declared = Number(req.headers.get('content-length') ?? Number.NaN);
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
          return json({ ok: false, error: '图片过大(>5MB)' }, 413);
        }

        let fd: FormData;
        try {
          fd = await req.formData();
        } catch {
          return json({ ok: false, error: '需要 multipart/form-data（file 字段）' }, 400);
        }
        const file = fd.get('file');
        if (!file || typeof file === 'string') return json({ ok: false, error: '无文件' }, 400);

        const name = safeImageName(file.name || 'image.png');
        if (!name) return json({ ok: false, error: '只支持 png/jpg/jpeg/gif/webp 图片' }, 415);
        if (file.size > MAX_UPLOAD_BYTES) return json({ ok: false, error: '图片过大(>5MB)' }, 413);

        const data = new Uint8Array(await file.arrayBuffer());
        try {
          const saved = await saveUploadImage(driver, project.cwd, name, data);
          return json({ ok: true, path: saved.rel, abs: saved.abs, name: saved.name, size: data.length });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
  ];
}
