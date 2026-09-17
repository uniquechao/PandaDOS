/**
 * 普通消息：用户 / AI 的文本气泡 + 用户附图缩略图行（点击开灯箱）+ 附件下载 chip。
 * 正文超 MAX_TEXT 会被服务端 brief 截断，故气泡底也挂一条操作行（issue #288）：
 * 复制全文、必要时「查看完整内容」按 off 回源。
 */
import { ImgThumb } from '../ImgThumb';
import { Markdown } from '../Markdown';
import { localizeUtcTimes } from '../../lib/utctime';
import { tr } from '../../i18n/runtime';
import { DetailBody } from './detail';

export function MessageEvent({
  role,
  text,
  images,
  files,
  ts,
  off,
  pid,
  onOpenImage,
}: {
  role: 'user' | 'assistant';
  text: string;
  /** 用户附图的 cwd 相对路径（后端 ws/chat.ts 富化）；缺 pid/onOpenImage 时不渲染附图 */
  images?: string[];
  /** 用户附件（非图片）的 cwd 相对路径；渲染成走 fs/download 的文件 chip（同样需要 pid） */
  files?: string[];
  /** 消息行 ts：AI 正文里的 UTC 时间点换算本地时间时当参照日（issue #116） */
  ts?: number;
  /** 该消息的稳定标识（issue #288「查看完整内容」用） */
  off?: number;
  pid?: number;
  onOpenImage?: (path: string) => void;
}) {
  const imgs = pid != null && images && images.length ? images : [];
  const atts = pid != null && files && files.length ? files : [];
  const hasImgs = imgs.length > 0;
  // 纯图消息（有图无正文）：加 imgonly 去掉气泡底/内边距，且不渲染空文本节点。
  // 只有附件（无图）时不去底：文件 chip 本身要贴在气泡里才读得出「这是我发的」。
  return (
    <div class={`rs-msg ${role}${hasImgs && !text ? ' imgonly' : ''}`}>
      {text ? (
        <DetailBody
          className="rs-msg-body"
          text={text}
          off={off}
          role={role}
          // AI 正文：先就地补本地时间（`6:50am (UTC)`，原文保留），再按 markdown 渲染
          // （issue #298 —— 表格是重点，容错见 lib/markdown）。
          // 用户自己打的字一个都不动：不换算时间，也不当 markdown 解析。
          render={(t) =>
            role === 'assistant' ? <Markdown text={localizeUtcTimes(t, ts)} /> : <>{t}</>
          }
        />
      ) : null}
      {hasImgs && (
        <div class="rs-msg-imgs">
          {imgs.map((p) => (
            <ImgThumb key={p} pid={pid!} path={p} onOpen={(x) => onOpenImage?.(x)} />
          ))}
        </div>
      )}
      {atts.length > 0 && (
        <div class="rs-msg-files">
          {atts.map((p) => {
            const name = p.split('/').pop() ?? p;
            return (
              <a
                key={p}
                class="rs-file"
                href={`/api/projects/${pid!}/fs/download?path=${encodeURIComponent(p)}`}
                download={name}
                title={tr('ui.downloadFile', { name })}
                aria-label={tr('ui.downloadFile', { name })}
              >
                <span class="rs-file-ico">📎</span>
                <span class="rs-file-name">{name}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
