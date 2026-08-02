import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8');

describe('ChatView 对话原生模式', () => {
  test('选中的对话通过共享对话/原生开关维护模式', () => {
    expect(source).toContain("from '../components/NativeModeSwitch'");
    expect(source).toContain('NativeModeSwitch');
    expect(source).toContain("useState<NativeMode>('chat')");
  });

  test('原生模式将选中 conversation 连接到它自己的 chat tmux 会话', () => {
    expect(source).toContain("from '../components/TermPane'");
    expect(source).toContain('<TermPane');
    expect(source).toContain("target={{ kind: 'conversation', convId: selected }}");
    expect(source).toContain('if (initial) activate(initial)');
    expect(source).toContain('function NativeConversationTerminal');
    expect(source).toContain('setReady(true)');
    expect(source).toContain("/activate`, 'POST'");
  });

  test('切换会话时为聊天和原生终端卸载旧连接', () => {
    expect(source).toContain('key={`chat:${selected}`}');
    expect(source).toContain('key={`native:${selected}`}');
  });

  test('手机整页和宽屏主栏复用同一个含模式开关的会话面板', () => {
    expect(source).toContain('<ConversationPane');
    expect(source).toContain('mode={mode}');
    expect(source).toContain('onModeChange={setMode}');
    expect(source).toContain('<div class="wb-main">');
  });

  test('项目页头的原生入口命名为原生 Bash', () => {
    expect(source).toContain("t('view.nativeBash')");
    expect(source).not.toContain('>\n              终端\n            </button>');
  });
});

describe('ChatView 当前模型徽标（issue #109）', () => {
  test('头行（switcher）里跟着自动批准钮显示所选对话的模型，宽窄屏/原生模式同一位置', () => {
    expect(source).toContain("from '../lib/useConvModel'");
    expect(source).toContain('useConvModel(pid, selected)');
    expect(source).toContain('<ModelBadge model={model} />');
    const idxSwitch = source.indexOf('<AutoApproveSwitch level={autoApprove}');
    expect(idxSwitch).toBeGreaterThan(0);
    expect(source.indexOf('<ModelBadge model={model} />')).toBeGreaterThan(idxSwitch); // 同一 switcher 行内
  });
});
