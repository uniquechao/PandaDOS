import type { SupportedLocale } from '../locales';
import type { MessageCatalog } from '../messages';
import { deCatalog } from './de';
import { enCatalog } from './en';
import { esCatalog } from './es';
import { frCatalog } from './fr';
import { jaCatalog } from './ja';
import { koCatalog } from './ko';
import { ptBrCatalog } from './pt-BR';
import { ruCatalog } from './ru';
import { zhHansCatalog } from './zh-Hans';
import { zhHantCatalog } from './zh-Hant';

export const catalogs: Readonly<Record<SupportedLocale, MessageCatalog>> = {
  en: enCatalog,
  'zh-Hans': zhHansCatalog,
  'zh-Hant': zhHantCatalog,
  ja: jaCatalog,
  ko: koCatalog,
  es: esCatalog,
  fr: frCatalog,
  de: deCatalog,
  'pt-BR': ptBrCatalog,
  ru: ruCatalog,
};

export async function loadCatalog(locale: SupportedLocale): Promise<MessageCatalog> {
  switch (locale) {
    case 'en':
      return enCatalog;
    case 'zh-Hans':
      return (await import('./zh-Hans')).zhHansCatalog;
    case 'zh-Hant':
      return (await import('./zh-Hant')).zhHantCatalog;
    case 'ja':
      return (await import('./ja')).jaCatalog;
    case 'ko':
      return (await import('./ko')).koCatalog;
    case 'es':
      return (await import('./es')).esCatalog;
    case 'fr':
      return (await import('./fr')).frCatalog;
    case 'de':
      return (await import('./de')).deCatalog;
    case 'pt-BR':
      return (await import('./pt-BR')).ptBrCatalog;
    case 'ru':
      return (await import('./ru')).ruCatalog;
  }
}
