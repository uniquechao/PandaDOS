/** 异常：工具/命令报错的结果正文，醒目呈现（区别于普通结果）。 */
import { tr } from '../../i18n/runtime';
export function ExceptionView({ text }: { text: string }) {
  return (
    <div class="rs-exc">
      <div class="rs-exc-hd">⚠ {tr('ui.exception')}</div>
      <div class="rs-exc-b">
        {text.split('\n').map((l, k) => (
          <div key={k}>{l || ' '}</div>
        ))}
      </div>
    </div>
  );
}
