import { LOCALE_META, SUPPORTED_LOCALES, type SupportedLocale } from '../../../shared/i18n/locales';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useI18n } from './provider';

function GlobeIcon() {
  return (
    <svg class="locale-select-globe" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.4 5.1 3.4 8.5S14.2 18.2 12 20.5M12 3.5C9.8 5.8 8.6 8.6 8.6 12s1.2 6.2 3.4 8.5" />
    </svg>
  );
}

function CompactLanguageSelect({
  value,
  onChange,
}: {
  value: SupportedLocale;
  onChange(locale: SupportedLocale): Promise<void> | void;
}) {
  const { t, localeLoading } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      optionRefs.current[SUPPORTED_LOCALES.indexOf(value)]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, value]);

  const pick = (locale: SupportedLocale): void => {
    setOpen(false);
    void Promise.resolve(onChange(locale)).catch(() => {});
  };

  const moveFocus = (direction: -1 | 1): void => {
    if (!open) {
      setOpen(true);
      return;
    }
    const current = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const start = current < 0 ? SUPPORTED_LOCALES.indexOf(value) : current;
    const next = (start + direction + SUPPORTED_LOCALES.length) % SUPPORTED_LOCALES.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <div
      class="locale-select compact"
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
        if (open && event.key === 'Home') {
          event.preventDefault();
          optionRefs.current[0]?.focus();
        }
        if (open && event.key === 'End') {
          event.preventDefault();
          optionRefs.current[SUPPORTED_LOCALES.length - 1]?.focus();
        }
      }}
    >
      <button
        type="button"
        class="locale-select-control"
        ref={triggerRef}
        disabled={localeLoading}
        aria-label={t('locale.languageAria')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <GlobeIcon />
        <span class="locale-select-current">{LOCALE_META[value].autonym}</span>
        <svg class={`locale-select-chevron${open ? ' open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div class="locale-select-menu" role="listbox" aria-label={t('locale.languageAria')}>
          {SUPPORTED_LOCALES.map((locale, index) => (
            <button
              type="button"
              role="option"
              aria-selected={locale === value}
              class={`locale-select-option${locale === value ? ' on' : ''}`}
              key={locale}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              onClick={() => pick(locale)}
            >
              <svg class="locale-select-check" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8.2 2.8 2.8 6.2-6.2" />
              </svg>
              <span>{LOCALE_META[locale].autonym}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LanguageSelect({
  value,
  onChange,
  compact = false,
}: {
  value: SupportedLocale;
  onChange(locale: SupportedLocale): Promise<void> | void;
  compact?: boolean;
}) {
  const { t, localeLoading } = useI18n();
  if (compact) return <CompactLanguageSelect value={value} onChange={onChange} />;

  return (
    <label class="locale-select">
      <span>{t('settings.language')}</span>
      <span class="locale-select-control">
        <select
          value={value}
          disabled={localeLoading}
          aria-label={t('locale.languageAria')}
          onChange={(event) => {
            void Promise.resolve(onChange(event.currentTarget.value as SupportedLocale)).catch(() => {});
          }}
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_META[locale].autonym}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
