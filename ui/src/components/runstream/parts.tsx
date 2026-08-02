/** runstream 共享小件：状态徽标、diff 着色行、单行预览。 */
import type { RunStatus } from '../../lib/runstream';
import { tr } from '../../i18n/runtime';

export { firstLine } from './textutil';

/** 工具/命令状态徽标：运行中（转圈）/ 成功 / 失败 */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  if (status === 'running') {
    return (
      <span class="rs-badge run">
        <span class="tool-spin" />
        {tr('ui.runRunning')}
      </span>
    );
  }
  if (status === 'error') return <span class="rs-badge err">✕ {tr('ui.failed')}</span>;
  return <span class="rs-badge ok">✓ {tr('ui.succeeded')}</span>;
}

/** 多行文本按 "- "/"+ " 前缀着色（toolfmt diff 正文）；空行占位保高。 */
export function DiffLines({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((l, k) => (
        <div key={k} class={l.startsWith('+ ') ? 'dfa' : l.startsWith('- ') ? 'dfd' : ''}>
          {l || ' '}
        </div>
      ))}
    </>
  );
}
