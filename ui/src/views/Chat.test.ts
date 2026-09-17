import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

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

describe('ChatView 导入当前项目本地历史（issue #7）', () => {
  const modal = source.match(/function ImportLocalHistoryModal[\s\S]*?\n}\n\n\/\*\* 选中对话/)?.[0] ?? '';

  test('对话列表提供导入入口，并查询当前项目可信历史摘要', () => {
    expect(source).toContain("t('view.importLocalHistory')");
    expect(source).toContain('setImportingHistory(true)');
    expect(modal).toContain('/api/projects/${pid}/conversations/local-history');
    expect(modal).toContain("const [filter, setFilter] = useState<HistoryAgentFilter>('all')");
  });

  test('只提交 agent 与 sessionId，导入后重新拉取列表并进入可继续聊天的对话', () => {
    expect(source).toContain('LocalHistoryResponse');
    expect(source).toContain('LocalHistoryImportResponse');
    expect(modal).toContain('.map((session) => ({ agent: session.agent, sessionId: session.sessionId }))');
    expect(modal).toMatch(/'POST',\s*\{ sessions: chosen \}/);
    expect(source).toContain('const enterImportedHistory = async (conversation: Conversation)');
    expect(source).toContain('setSelected(conversation.id)');
    expect(source).toContain('activate(conversation.id)');
    expect(source).toContain('setConvs(r.conversations)');
    expect(source).toContain("setMode('chat')");
    expect(source).toContain('if (target && target !== conversation.id) activate(target)');
  });

  test('当前 cwd 与历史导入响应使用共享类型契约，不暴露执行机历史路径', () => {
    expect(modal).toContain('api<LocalHistoryResponse>');
    expect(modal).toContain('api<LocalHistoryImportResponse>');
    expect(modal).toContain("t('view.localHistoryHelp')");
    expect(modal).toContain('{cwd}');
    expect(modal).not.toContain('jsonlPath');
  });

  test('候选支持批量选择，并公开加载、错误、已导入与选择数量状态', () => {
    expect(modal).toContain('type="checkbox"');
    expect(modal).toContain('disabled={imported || busy}');
    expect(modal).toContain('role="status" aria-live="polite"');
    expect(modal).toContain('role="alert"');
    expect(modal).toContain("t('view.historyAlreadyImported')");
    expect(modal).toContain("t('view.historySelected', { count: selected.size })");
  });

  test('PandaDOS 样式覆盖键盘焦点、窄屏、触屏、Hover 与禁用项', () => {
    expect(css).toContain('.history-import-item:focus-within { outline: 2px solid var(--accent);');
    expect(css).toContain('@media (hover: hover) {\n  .history-import-item:hover:not(.imported)');
    expect(css).toContain('.history-import-item.imported { opacity: 0.62; cursor: default; transition: none; }');
    expect(css).toContain('@media (max-width: 559px) {\n  .history-import-toolbar');
    expect(css).toContain('@media (pointer: coarse) {\n  .history-import-item { min-height: 68px; }');
  });
});

describe('ChatView 对话 id 与地址栏（#302）', () => {
  test('选中的对话写进地址栏，深链优先于本地记忆', () => {
    expect(source).toContain('function ChatView({ pid, cid }');
    expect(source).toContain('const linked = r.conversations.find((c) => c.id === cidRef.current)?.id ?? null;');
    expect(source).toContain('linked ?? restoreChatConversation(pid, r.conversations)');
    expect(source).toContain("import { resolveChatSync } from '../lib/chatsync';");
    // 同步只能有一个 effect：两个方向各一个会互相对打，生产上跑出过 1983 条 pending 请求
    expect(source).toContain('prevCid: prevCidRef.current,');
    expect(source.match(/resolveChatSync\(/g)?.length).toBe(1);
  });

  test('工具条里给出可复制的对话 id（网页/tmux/库三边对账）', () => {
    expect(source).toContain('function ConvIdChip');
    expect(source).toContain('<ConvIdChip id={selected} />');
    expect(source).toContain("copyText(id)");
    expect(source).toContain("t('view.copyConversationId', { id })");
    expect(css).toContain('.conv-id {');
  });
});
