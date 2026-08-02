export const SUPPORTED_LOCALES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'pt-BR',
  'ru',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export interface LocaleMeta {
  locale: SupportedLocale;
  autonym: string;
  englishName: string;
}

export const LOCALE_META: Readonly<Record<SupportedLocale, LocaleMeta>> = {
  en: { locale: 'en', autonym: 'English', englishName: 'English' },
  'zh-Hans': { locale: 'zh-Hans', autonym: '简体中文', englishName: 'Simplified Chinese' },
  'zh-Hant': { locale: 'zh-Hant', autonym: '繁體中文', englishName: 'Traditional Chinese' },
  ja: { locale: 'ja', autonym: '日本語', englishName: 'Japanese' },
  ko: { locale: 'ko', autonym: '한국어', englishName: 'Korean' },
  es: { locale: 'es', autonym: 'Español', englishName: 'Spanish' },
  fr: { locale: 'fr', autonym: 'Français', englishName: 'French' },
  de: { locale: 'de', autonym: 'Deutsch', englishName: 'German' },
  'pt-BR': { locale: 'pt-BR', autonym: 'Português (Brasil)', englishName: 'Brazilian Portuguese' },
  ru: { locale: 'ru', autonym: 'Русский', englishName: 'Russian' },
};

const supportedSet = new Set<string>(SUPPORTED_LOCALES);

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && supportedSet.has(value);
}

function canonicalLocale(value: string): string | null {
  const normalized = value.trim().replaceAll('_', '-');
  if (!normalized) return null;
  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? null;
  } catch {
    return null;
  }
}

function matchOne(value: string): SupportedLocale | null {
  const canonical = canonicalLocale(value);
  if (!canonical) return null;
  if (isSupportedLocale(canonical)) return canonical;

  const parts = canonical.split('-');
  const language = parts[0]?.toLowerCase();
  if (language === 'zh') {
    const subtags = new Set(parts.slice(1).map((part) => part.toLowerCase()));
    return subtags.has('hant') || subtags.has('tw') || subtags.has('hk') || subtags.has('mo')
      ? 'zh-Hant'
      : 'zh-Hans';
  }
  if (language === 'pt') return 'pt-BR';
  if (language && isSupportedLocale(language)) return language;
  return null;
}

export function matchSupportedLocale(candidates: readonly string[]): SupportedLocale {
  for (const candidate of candidates) {
    const matched = matchOne(candidate);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
