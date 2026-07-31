import { describe, expect, test } from 'bun:test';
import { parseHash } from './router';
import { buildLlmConfigUpdate, llmConfigGuidance } from './llmConfig';

describe('驱动大模型 UI 状态', () => {
  test('普通用户未配置时只提示联系管理员；管理员得到直达配置路径', () => {
    expect(llmConfigGuidance('user', false)).toEqual({
      message: '请联系管理员配置驱动大模型',
      actionPath: null,
    });
    expect(llmConfigGuidance('admin', false)).toEqual({
      message: '请联系管理员配置驱动大模型',
      actionPath: '/admin/llm',
    });
    expect(llmConfigGuidance('admin', true)).toBeNull();
  });

  test('保存 payload 中空 Key 表示保留；清除必须显式 clearApiKey', () => {
    expect(buildLlmConfigUpdate({
      baseUrl: ' https://llm.example/v1/ ',
      model: ' model-a ',
      apiKey: '',
      clearApiKey: false,
    })).toEqual({
      baseUrl: 'https://llm.example/v1',
      model: 'model-a',
    });
    expect(buildLlmConfigUpdate({
      baseUrl: 'https://llm.example/v1',
      model: 'model-a',
      apiKey: '',
      clearApiKey: true,
    })).toEqual({
      baseUrl: 'https://llm.example/v1',
      model: 'model-a',
      clearApiKey: true,
    });
  });

  test('#/admin/llm 解析为 Admin 的驱动大模型页签', () => {
    expect(parseHash('#/admin/llm')).toEqual({ name: 'admin', section: 'llm' });
    expect(parseHash('#/admin')).toEqual({ name: 'admin' });
  });
});
