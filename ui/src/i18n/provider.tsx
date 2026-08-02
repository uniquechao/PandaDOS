import { createContext, Fragment, type ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { enCatalog } from '../../../shared/i18n/catalogs/en';
import { createI18n, type I18nApi } from '../../../shared/i18n/formatter';
import type { SupportedLocale } from '../../../shared/i18n/locales';
import type { MessageCatalog } from '../../../shared/i18n/messages';
import { api } from '../lib/api';
import type { Me, UserSettings } from '../lib/types';
import { toast } from '../lib/toast';
import { detectBrowserTimeZone, readDeviceLocale, writeDeviceLocale } from './preference';
import { LatestActivation } from './activation';
import { setRuntimeI18n } from './runtime';

export interface BrowserI18n extends I18nApi {
  fixedTimeZone: string | null;
  detectedTimeZone: string;
  localeLoading: boolean;
  setLocale(locale: SupportedLocale): Promise<void>;
  setTimeZone(timeZone: string | null): Promise<void>;
}

const I18nContext = createContext<BrowserI18n | null>(null);

async function fetchCatalog(locale: SupportedLocale): Promise<MessageCatalog> {
  switch (locale) {
    case 'en':
      return enCatalog;
    case 'zh-Hans':
      return (await import('../../../shared/i18n/catalogs/zh-Hans')).zhHansCatalog;
    case 'zh-Hant':
      return (await import('../../../shared/i18n/catalogs/zh-Hant')).zhHantCatalog;
    case 'ja':
      return (await import('../../../shared/i18n/catalogs/ja')).jaCatalog;
    case 'ko':
      return (await import('../../../shared/i18n/catalogs/ko')).koCatalog;
    case 'es':
      return (await import('../../../shared/i18n/catalogs/es')).esCatalog;
    case 'fr':
      return (await import('../../../shared/i18n/catalogs/fr')).frCatalog;
    case 'de':
      return (await import('../../../shared/i18n/catalogs/de')).deCatalog;
    case 'pt-BR':
      return (await import('../../../shared/i18n/catalogs/pt-BR')).ptBrCatalog;
    case 'ru':
      return (await import('../../../shared/i18n/catalogs/ru')).ruCatalog;
  }
}

export function I18nProvider({ me, children }: { me: Me | null | undefined; children: ComponentChildren }) {
  const initialLocale = useMemo(readDeviceLocale, []);
  const detectedTimeZone = useMemo(detectBrowserTimeZone, []);
  const [locale, setLocaleState] = useState<SupportedLocale>(initialLocale);
  const [catalog, setCatalog] = useState<MessageCatalog>(enCatalog);
  const [fixedTimeZone, setFixedTimeZone] = useState<string | null>(null);
  const [localeLoading, setLocaleLoading] = useState(initialLocale !== 'en');
  const localeRef = useRef(locale);
  const meRef = useRef(me);
  const warnedLoad = useRef(false);
  const syncedUser = useRef<number | null>(null);
  const activation = useRef(new LatestActivation());

  localeRef.current = locale;
  meRef.current = me;

  const activate = async (next: SupportedLocale): Promise<SupportedLocale | null> => {
    const generation = activation.current.begin();
    setLocaleLoading(true);
    try {
      const loaded = await fetchCatalog(next);
      if (!activation.current.isCurrent(generation)) return null;
      setCatalog(loaded);
      setLocaleState(next);
      localeRef.current = next;
      writeDeviceLocale(undefined, next);
      document.documentElement.lang = next;
      return next;
    } catch (error) {
      if (!activation.current.isCurrent(generation)) return null;
      setCatalog(enCatalog);
      setLocaleState('en');
      localeRef.current = 'en';
      writeDeviceLocale(undefined, 'en');
      document.documentElement.lang = 'en';
      if (!warnedLoad.current) {
        warnedLoad.current = true;
        toast.error(enCatalog['locale.loadFailed']);
      }
      console.error('[i18n] catalog load failed:', error);
      return 'en';
    } finally {
      if (activation.current.isCurrent(generation)) setLocaleLoading(false);
    }
  };

  useEffect(() => {
    void activate(initialLocale);
  }, []);

  useEffect(() => {
    if (me === undefined) return;
    if (me === null) {
      syncedUser.current = null;
      setFixedTimeZone(null);
      return;
    }
    if (syncedUser.current === me.id) return;
    syncedUser.current = me.id;
    setFixedTimeZone(me.timezone);
    const accountLocale = me.locale ?? localeRef.current;
    void activate(accountLocale).then(async (effectiveLocale) => {
      if (effectiveLocale === null) return;
      const patch: Partial<UserSettings> = {};
      if (me.locale === null) patch.locale = effectiveLocale;
      if (me.detectedTimezone !== detectedTimeZone) patch.detectedTimezone = detectedTimeZone;
      if (Object.keys(patch).length > 0) {
        await api('/api/me/settings', 'PUT', patch).catch((error) => {
          console.error('[i18n] account preference initialization failed:', error);
        });
      }
    });
  }, [me, detectedTimeZone]);

  const setLocale = async (next: SupportedLocale): Promise<void> => {
    if (next === localeRef.current) return;
    const previous = localeRef.current;
    const effectiveLocale = await activate(next);
    if (effectiveLocale !== next) return;
    if (!meRef.current) return;
    try {
      await api('/api/me/settings', 'PUT', { locale: next });
    } catch (error) {
      await activate(previous);
      toast.error(base.t('settings.preferenceSaveFailed'));
      throw error;
    }
  };

  const setTimeZone = async (next: string | null): Promise<void> => {
    const previous = fixedTimeZone;
    setFixedTimeZone(next);
    if (!meRef.current) return;
    try {
      await api('/api/me/settings', 'PUT', { timezone: next });
    } catch (error) {
      setFixedTimeZone(previous);
      toast.error(base.t('settings.preferenceSaveFailed'));
      throw error;
    }
  };

  const effectiveTimeZone = fixedTimeZone ?? detectedTimeZone;
  const base = useMemo(
    () => createI18n({ locale, timeZone: effectiveTimeZone, catalog }),
    [locale, effectiveTimeZone, catalog],
  );
  const value = useMemo<BrowserI18n>(
    () => ({
      ...base,
      fixedTimeZone,
      detectedTimeZone,
      localeLoading,
      setLocale,
      setTimeZone,
    }),
    [base, fixedTimeZone, detectedTimeZone, localeLoading],
  );
  setRuntimeI18n(base);

  return (
    <I18nContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

export function useI18n(): BrowserI18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
