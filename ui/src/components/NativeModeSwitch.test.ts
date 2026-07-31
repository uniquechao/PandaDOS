import { describe, expect, test } from 'bun:test';

const switchUrl = new URL('./NativeModeSwitch.tsx', import.meta.url);

describe('NativeModeSwitch', () => {
  test('提供共享的对话/原生分段切换 API 与中文标签', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain("export type NativeMode = 'chat' | 'native';");
    expect(source).toContain('export function NativeModeSwitch({ mode, onChange }: NativeModeSwitchProps)');
    expect(source).toContain('class="wb-seg"');
    expect(source).toContain("onClick={() => onChange('chat')}");
    expect(source).toContain("onClick={() => onChange('native')}");
    expect(source).toContain('对话');
    expect(source).toContain('原生');
  });
});
