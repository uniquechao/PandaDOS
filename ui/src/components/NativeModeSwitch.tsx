import type { JSX } from 'preact';

export type NativeMode = 'chat' | 'native';

interface NativeModeSwitchProps {
  mode: NativeMode;
  onChange: (mode: NativeMode) => void;
}

export function NativeModeSwitch({ mode, onChange }: NativeModeSwitchProps): JSX.Element {
  return (
    <div class="wb-seg">
      <button class={mode === 'chat' ? 'on' : ''} onClick={() => onChange('chat')}>
        对话
      </button>
      <button class={mode === 'native' ? 'on' : ''} onClick={() => onChange('native')}>
        原生
      </button>
    </div>
  );
}
