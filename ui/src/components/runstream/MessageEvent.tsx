/** 普通消息：用户 / AI 的文本气泡 + 用户附图缩略图行（点击开灯箱）。 */
import { ImgThumb } from '../ImgThumb';
import { localizeUtcTimes } from '../../lib/utctime';

export function MessageEvent({
  role,
  text,
  images,
  ts,
  pid,
  onOpenImage,
}: {
  role: 'user' | 'assistant';
  text: string;
  /** 用户附图的 cwd 相对路径（后端 ws/chat.ts 富化）；缺 pid/onOpenImage 时不渲染附图 */
  images?: string[];
  /** 消息行 ts：AI 正文里的 UTC 时间点换算本地时间时当参照日（issue #116） */
  ts?: number;
  pid?: number;
  onOpenImage?: (path: string) => void;
}) {
  const imgs = pid != null && images && images.length ? images : [];
  const hasImgs = imgs.length > 0;
  // AI 正文里的 `6:50am (UTC)` 就地补一份本地时间（原文保留）；用户自己打的字一个都不动。
  const body = role === 'assistant' ? localizeUtcTimes(text, ts) : text;
  // 纯图消息（有图无正文）：加 imgonly 去掉气泡底/内边距，且不渲染空文本节点。
  return (
    <div class={`rs-msg ${role}${hasImgs && !text ? ' imgonly' : ''}`}>
      {body ? body : null}
      {hasImgs && (
        <div class="rs-msg-imgs">
          {imgs.map((p) => (
            <ImgThumb key={p} pid={pid!} path={p} onOpen={(x) => onOpenImage?.(x)} />
          ))}
        </div>
      )}
    </div>
  );
}
