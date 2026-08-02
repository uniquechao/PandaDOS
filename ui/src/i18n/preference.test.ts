import { describe, expect, test } from 'bun:test';
import { detectBrowserTimeZone, readDeviceLocale, writeDeviceLocale } from './preference';

class StorageStub {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

describe('login locale preference', () => {
  test('saved manual language wins over browser languages', () => {
    const storage = new StorageStub();
    storage.value = 'de';
    expect(readDeviceLocale(storage, ['zh-TW', 'en'])).toBe('de');
  });

  test('browser language initializes the device and unsupported values fall back to English', () => {
    const storage = new StorageStub();
    expect(readDeviceLocale(storage, ['zh-TW', 'en'])).toBe('zh-Hant');
    expect(readDeviceLocale(storage, ['ar-EG'])).toBe('en');
  });

  test('corrupt or unavailable storage never blocks login', () => {
    const broken = {
      getItem(): string | null {
        throw new Error('denied');
      },
      setItem(): void {
        throw new Error('denied');
      },
    };
    expect(readDeviceLocale(broken, ['fr-FR'])).toBe('fr');
    expect(() => writeDeviceLocale(broken, 'ja')).not.toThrow();
  });

  test('writes only supported explicit locale values', () => {
    const storage = new StorageStub();
    writeDeviceLocale(storage, 'pt-BR');
    expect(storage.value).toBe('pt-BR');
  });
});

describe('browser timezone detection', () => {
  test('uses a valid resolved IANA timezone and otherwise UTC', () => {
    expect(detectBrowserTimeZone(() => 'Asia/Singapore')).toBe('Asia/Singapore');
    expect(detectBrowserTimeZone(() => 'Mars/Olympus')).toBe('UTC');
    expect(detectBrowserTimeZone(() => { throw new Error('no Intl'); })).toBe('UTC');
  });
});
