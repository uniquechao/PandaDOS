/**
 * 思考摘要：默认收起首行摘要，点开在下方给出全文块（可复制、可长按拖选；超 MAX_TEXT 被服务端
 * 截断过的还能「查看完整内容」按 off 回源，见 issue #288）。
 * 展开时头行只留 💭 与楔形——正文已经在下面整块铺开，再重复一遍摘要只是噪声。
 */
import { useState } from 'preact/hooks';
import { firstLine } from './parts';
import { DetailBody } from './detail';

export function ThinkingEvent({ text, off }: { text: string; off?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || text.includes('\n');
  return (
    <div class="rs-think">
      <div class="rs-think-h" onClick={() => long && setOpen(!open)}>
        <span class="rs-ic">💭</span>
        {!open && <span class="rs-think-tx">{long ? firstLine(text, 140) : text}</span>}
        {long && <span class="rs-tw">{open ? '▾' : '▸'}</span>}
      </div>
      {open && (
        <div class="rs-think-b">
          <DetailBody text={text} off={off} role="thinking" render={(t) => <>{t}</>} />
        </div>
      )}
    </div>
  );
}
