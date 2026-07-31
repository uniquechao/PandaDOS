/** 思考摘要：默认收起首行摘要，点开看全文。 */
import { useState } from 'preact/hooks';
import { firstLine } from './parts';

export function ThinkingEvent({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || text.includes('\n');
  return (
    <div class="rs-think">
      <div class="rs-think-h" onClick={() => long && setOpen(!open)}>
        <span class="rs-ic">💭</span>
        <span class="rs-think-tx">{open || !long ? text : firstLine(text, 140)}</span>
        {long && <span class="rs-tw">{open ? '▾' : '▸'}</span>}
      </div>
    </div>
  );
}
