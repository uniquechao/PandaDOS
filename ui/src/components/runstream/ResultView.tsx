/** 结果：工具/命令的成功（普通）结果正文，按 diff 前缀着色。 */
import { DiffLines } from './parts';

export function ResultView({ text }: { text: string }) {
  return (
    <div class="rs-result">
      <DiffLines text={text} />
    </div>
  );
}
