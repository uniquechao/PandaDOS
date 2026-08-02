import { IntlMessageFormat } from 'intl-messageformat';
import { enCatalog } from './catalogs/en';
import type { SupportedLocale } from './locales';
import type { MessageCatalog, MessageKey, MessageValues } from './messages';

export interface CreateI18nOptions {
  locale: SupportedLocale;
  timeZone: string;
  catalog: MessageCatalog;
  onDiagnostic?: (message: string) => void;
}

export interface I18nApi {
  readonly locale: SupportedLocale;
  readonly timeZone: string;
  t(key: MessageKey, values?: MessageValues): string;
  formatDateTime(ts: number | Date, options?: Intl.DateTimeFormatOptions): string;
  formatDate(ts: number | Date): string;
  formatTime(ts: number | Date): string;
  formatRelativeTime(ts: number | Date, now?: number | Date): string;
  formatNumber(value: number): string;
  formatList(values: readonly string[]): string;
}

const asDate = (value: number | Date): Date => (value instanceof Date ? value : new Date(value));
const asMillis = (value: number | Date): number => (value instanceof Date ? value.getTime() : value);

export function createI18n(options: CreateI18nOptions): I18nApi {
  const { locale, timeZone, catalog, onDiagnostic } = options;
  const cache = new Map<string, IntlMessageFormat>();

  const t = (key: MessageKey, values: MessageValues = {}): string => {
    let message = catalog[key];
    if (typeof message !== 'string') {
      message = enCatalog[key];
      if (typeof message !== 'string') {
        onDiagnostic?.(`missing English message: ${key}`);
        return `[${key}]`;
      }
      onDiagnostic?.(`missing ${locale} message: ${key}`);
    }
    const cacheKey = `${locale}\u0000${key}\u0000${message}`;
    let formatter = cache.get(cacheKey);
    if (!formatter) {
      formatter = new IntlMessageFormat(message, locale);
      cache.set(cacheKey, formatter);
    }
    return String(formatter.format(values as never));
  };

  return {
    locale,
    timeZone,
    t,
    formatDateTime(ts, extra = {}) {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
        ...extra,
      }).format(asDate(ts));
    },
    formatDate(ts) {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(asDate(ts));
    },
    formatTime(ts) {
      return new Intl.DateTimeFormat(locale, {
        timeStyle: 'short',
        timeZone,
      }).format(asDate(ts));
    },
    formatRelativeTime(ts, now = Date.now()) {
      const seconds = Math.round((asMillis(ts) - asMillis(now)) / 1000);
      const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
      const minutes = Math.round(seconds / 60);
      if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
      const hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
      const days = Math.round(hours / 24);
      if (Math.abs(days) < 30) return formatter.format(days, 'day');
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(asDate(ts));
    },
    formatNumber(value) {
      return new Intl.NumberFormat(locale).format(value);
    },
    formatList(values) {
      return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(values);
    },
  };
}

const UTC_TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\((UTC|GMT)\)/gi;

export function nextUtcOccurrence(hour24: number, minute: number, refMs: number): number {
  const ref = new Date(refMs);
  let at = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hour24, minute, 0, 0);
  if (at < refMs) at += 86_400_000;
  return at;
}

function localDateParts(ts: number, i18n: I18nApi): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: i18n.timeZone,
  }).formatToParts(new Date(ts));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return [part('year'), part('month'), part('day')];
}

function dayDistance(atMs: number, refMs: number, i18n: I18nApi): number {
  const [ay, am, ad] = localDateParts(atMs, i18n);
  const [ry, rm, rd] = localDateParts(refMs, i18n);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(ry, rm - 1, rd)) / 86_400_000);
}

export function localizeUtcTimes(text: string, refMs: number, i18n: I18nApi): string {
  if (!text || !/\((UTC|GMT)\)/i.test(text)) return text;
  return text.replace(UTC_TIME_RE, (whole, h: string, m: string | undefined, ap: string | undefined) => {
    if (!ap && m === undefined) return whole;
    const hour = Number(h);
    const minute = m === undefined ? 0 : Number(m);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return whole;
    let hour24 = hour;
    if (ap) {
      if (hour < 1 || hour > 12) return whole;
      const pm = ap.toLowerCase() === 'pm';
      hour24 = hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
    } else if (hour > 23) {
      return whole;
    }
    const at = nextUtcOccurrence(hour24, minute, refMs);
    const distance = dayDistance(at, refMs, i18n);
    const prefix = distance === 1 ? `${i18n.t('date.tomorrow')} ` : distance > 1 ? `${i18n.formatDate(at)} ` : '';
    return `${whole.slice(0, -1)} → ${i18n.t('date.localTime')} ${prefix}${i18n.formatTime(at)})`;
  });
}
