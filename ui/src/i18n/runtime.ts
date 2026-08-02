import { enCatalog } from '../../../shared/i18n/catalogs/en';
import { createI18n, type I18nApi } from '../../../shared/i18n/formatter';
import type { MessageKey, MessageValues } from '../../../shared/i18n/messages';

let current: I18nApi = createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog });

export function setRuntimeI18n(i18n: I18nApi): void {
  current = i18n;
}

export function runtimeI18n(): I18nApi {
  return current;
}

export function tr(key: MessageKey, values?: MessageValues): string {
  return current.t(key, values);
}
