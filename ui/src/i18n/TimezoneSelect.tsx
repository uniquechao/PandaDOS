import { useEffect, useMemo, useState } from 'preact/hooks';
import { isValidTimeZone } from '../../../shared/i18n/locales';
import { useI18n } from './provider';

function supportedTimeZones(): string[] {
  try {
    const values = Intl.supportedValuesOf?.('timeZone');
    return values ? [...values] : [];
  } catch {
    return [];
  }
}

export function TimezoneSelect() {
  const { t, fixedTimeZone, detectedTimeZone, setTimeZone } = useI18n();
  const [draft, setDraft] = useState(fixedTimeZone ?? '');
  const [busy, setBusy] = useState(false);
  const zones = useMemo(supportedTimeZones, []);
  useEffect(() => setDraft(fixedTimeZone ?? ''), [fixedTimeZone]);

  const apply = async (value: string | null): Promise<void> => {
    if (busy || value === fixedTimeZone) return;
    if (value !== null && !isValidTimeZone(value)) return;
    setBusy(true);
    try {
      await setTimeZone(value);
    } catch {
      setDraft(fixedTimeZone ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label class="field timezone-field">
      {t('settings.timezone')}
      <div class="row">
        <input
          class="grow"
          list="mando-timezones"
          value={draft}
          disabled={busy}
          placeholder={t('settings.timezoneAutomatic', { zone: detectedTimeZone })}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => {
            if (draft && isValidTimeZone(draft)) void apply(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft && isValidTimeZone(draft)) {
              event.preventDefault();
              void apply(draft);
            }
          }}
        />
        <button class="btn sm" type="button" disabled={busy || fixedTimeZone === null} onClick={() => void apply(null)}>
          {t('settings.timezoneAutoButton')}
        </button>
      </div>
      <datalist id="mando-timezones">
        {zones.map((zone) => <option key={zone} value={zone} />)}
      </datalist>
    </label>
  );
}
