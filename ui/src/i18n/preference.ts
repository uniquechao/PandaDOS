import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  isValidTimeZone,
  matchSupportedLocale,
  type SupportedLocale,
} from '../../../shared/i18n/locales';

export const DEVICE_LOCALE_KEY = 'mando.locale';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultBrowserLanguages(): readonly string[] {
  try {
    return typeof navigator === 'undefined' ? [] : navigator.languages;
  } catch {
    return [];
  }
}

export function readDeviceLocale(
  storage: StorageLike | null = defaultStorage(),
  browserLanguages: readonly string[] = defaultBrowserLanguages(),
): SupportedLocale {
  try {
    const saved = storage?.getItem(DEVICE_LOCALE_KEY);
    if (isSupportedLocale(saved)) return saved;
  } catch {
    // Private browsing and hardened storage policies must not block login.
  }
  return browserLanguages.length > 0 ? matchSupportedLocale(browserLanguages) : DEFAULT_LOCALE;
}

export function writeDeviceLocale(
  storage: StorageLike | null = defaultStorage(),
  locale: SupportedLocale,
): void {
  try {
    storage?.setItem(DEVICE_LOCALE_KEY, locale);
  } catch {
    // The in-memory provider still changes language for this session.
  }
}

export function detectBrowserTimeZone(
  resolve: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  try {
    const zone = resolve();
    return isValidTimeZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}
