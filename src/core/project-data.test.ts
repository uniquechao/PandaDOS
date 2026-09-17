import { describe, expect, test } from 'bun:test';
import {
  PANDA_PROJECT_DATA,
  PANDA_PROJECT_DATA_VERSION,
  isSyncUid,
  uuidV7,
} from './project-data';

describe('版本化 .panda 协作数据契约', () => {
  test('固定根目录、格式标识与首版目录布局', () => {
    expect(PANDA_PROJECT_DATA).toEqual({
      root: '.panda',
      schema: 'pandados.project-data',
      project: '.panda/project.json',
      modules: '.panda/modules',
      workflows: '.panda/workflows',
      designs: '.panda/designs',
      conversations: '.panda/conversations',
      uploads: '.panda/uploads',
      excluded: ['.panda/tmp'],
    });
    expect(PANDA_PROJECT_DATA_VERSION).toBe(1);
  });

  test('UUIDv7 合法、携带毫秒时间且可按时间排序', () => {
    const random = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const first = uuidV7(1_700_000_000_000, random);
    const second = uuidV7(1_700_000_000_001, random);
    expect(first).toBe('018bcfe5-6800-7102-8304-05060708090a');
    expect(isSyncUid(first)).toBe(true);
    expect(first < second).toBe(true);
    expect(isSyncUid('not-a-uuid')).toBe(false);
  });
});
