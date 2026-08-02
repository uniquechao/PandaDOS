import { describe, expect, test } from 'bun:test';

const switchUrl = new URL('./NativeModeSwitch.tsx', import.meta.url);

describe('NativeModeSwitch', () => {
  test('提供共享的对话/原生分段切换 API 与本地化标签', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain("export type NativeMode = 'chat' | 'native';");
    expect(source).toContain('export function NativeModeSwitch({ mode, onChange }: NativeModeSwitchProps)');
    expect(source).toContain('class="wb-seg"');
    expect(source).toContain("onClick={() => onChange('chat')}");
    expect(source).toContain("onClick={() => onChange('native')}");
    expect(source).toContain("t('ui.chat')");
    expect(source).toContain("t('ui.native')");
  });
});
