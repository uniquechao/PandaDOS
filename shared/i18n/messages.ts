import type { enCatalog } from './catalogs/en';

export type MessageKey = keyof typeof enCatalog;
export type MessageValues = Readonly<Record<string, unknown>>;
export type MessageCatalog = Readonly<Record<MessageKey, string>>;
