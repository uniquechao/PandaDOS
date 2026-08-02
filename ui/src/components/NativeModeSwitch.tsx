import type { JSX } from 'preact';
import { useI18n } from '../i18n/provider';

export type NativeMode = 'chat' | 'native';

interface NativeModeSwitchProps {
  mode: NativeMode;
  onChange: (mode: NativeMode) => void;
}

export function NativeModeSwitch({ mode, onChange }: NativeModeSwitchProps): JSX.Element {
  const { t } = useI18n();
  return (
    <div class="wb-seg">
      <button class={mode === 'chat' ? 'on' : ''} onClick={() => onChange('chat')}>
        {t('ui.chat')}
      </button>
      <button class={mode === 'native' ? 'on' : ''} onClick={() => onChange('native')}>
        {t('ui.native')}
      </button>
    </div>
  );
}
