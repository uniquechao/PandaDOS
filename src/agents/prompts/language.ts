import { DEFAULT_LOCALE, LOCALE_META, type SupportedLocale } from '../../../shared/i18n/locales';
import type { Database } from 'bun:sqlite';
import { CHINESE_AGENT_LANGUAGE } from './zh';
import { ENGLISH_AGENT_LANGUAGE } from './en';

export type PromptLanguage = 'en' | 'zh';

export function promptLanguage(locale: SupportedLocale = DEFAULT_LOCALE): PromptLanguage {
  return locale === 'zh-Hans' || locale === 'zh-Hant' ? 'zh' : 'en';
}

/**
 * This clause is appended to agent prompts. The locale code is deliberately retained as a
 * stable, machine-auditable value while the natural-language name tells the model what to emit.
 */
export function outputLanguageInstruction(locale: SupportedLocale = DEFAULT_LOCALE): string {
  const language = promptLanguage(locale) === 'zh' ? CHINESE_AGENT_LANGUAGE : ENGLISH_AGENT_LANGUAGE;
  const target = `${LOCALE_META[locale].englishName} (${locale})`;
  return `${language.outputLead} ${target}. ${language.preserve}`;
}

export function withOutputLanguage(text: string, locale: SupportedLocale = DEFAULT_LOCALE): string {
  return `${text}\n\n${outputLanguageInstruction(locale)}`;
}

/** Resolve at execution time so account language changes affect queued/background work. */
export function userPromptLocale(
  db: Database,
  userId: number | null | undefined,
  fallbackUserId?: number | null,
): SupportedLocale {
  for (const id of [userId, fallbackUserId]) {
    if (!id) continue;
    const row = db.query<{ locale: string | null }, [number]>(
      'SELECT locale FROM user_settings WHERE user_id = ?',
    ).get(id);
    if (row?.locale && row.locale in LOCALE_META) return row.locale as SupportedLocale;
  }
  return DEFAULT_LOCALE;
}
