import { describe, expect, test } from 'bun:test';
import type { ExternalIssueSourceConfig } from '../core/types';
import {
  externalIssueSourceKey,
  type ExternalIssueFetch,
  fetchOpenExternalIssues,
  normalizeInstanceUrl,
  parseGitRemoteUrl,
} from './external-provider';

function source(
  patch: Partial<ExternalIssueSourceConfig> = {},
): ExternalIssueSourceConfig {
  return {
    projectId: 1,
    provider: 'github',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:octo/repo.git',
    instanceUrl: 'https://github.com',
    apiToken: 'token',
    tokenUpdatedTs: 1,
    createdTs: 1,
    updatedTs: 1,
    ...patch,
  };
}

describe('Git remote 解析', () => {
  test('支持 scp、ssh 与带凭据的 https，统一去掉 .git 和 HTTP 凭据', () => {
    expect(parseGitRemoteUrl('git@github.com:Org/Repo.git')).toMatchObject({
      host: 'github.com',
      repoPath: 'Org/Repo',
      transport: 'ssh',
    });
    expect(parseGitRemoteUrl('ssh://git@gitlab.example:2222/group/repo.git')).toMatchObject({
      host: 'gitlab.example',
      port: '2222',
      repoPath: 'group/repo',
      transport: 'ssh',
    });
    expect(parseGitRemoteUrl('ssh://git:secret@gitlab.example/group/repo.git').safeUrl).toBe(
      'ssh://git@gitlab.example/group/repo.git',
    );
    expect(parseGitRemoteUrl('https://secret@gitlab.example/group/repo.git').safeUrl).toBe(
      'https://gitlab.example/group/repo.git',
    );
  });

  test('GitHub 只接受 github.com，GitLab 自建实例允许同主机子路径', () => {
    const github = parseGitRemoteUrl('git@github.com:o/r.git');
    expect(normalizeInstanceUrl('github', github)).toBe('https://github.com');
    expect(() => normalizeInstanceUrl('github', parseGitRemoteUrl('git@example.com:o/r.git'))).toThrow();
    const gitlab = parseGitRemoteUrl('https://gitlab.example/gitlab/group/repo.git');
    expect(normalizeInstanceUrl('gitlab', gitlab, 'https://gitlab.example/gitlab/')).toBe(
      'https://gitlab.example/gitlab',
    );
  });
});

describe('远端开放 issue 客户端', () => {
  test('GitHub 跟随 Link 分页并排除 Pull Request', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch: ExternalIssueFetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (calls.length === 1) {
        return new Response(JSON.stringify([
          {
            id: 10,
            number: 1,
            title: 'Issue A',
            body: 'Body A',
            html_url: 'https://github.com/octo/repo/issues/1',
            user: { login: 'alice' },
            labels: [{ name: 'bug' }],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
          },
          { id: 11, number: 2, title: 'PR', pull_request: {} },
        ]), {
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        });
      }
      return new Response(JSON.stringify([
        {
          id: 12,
          number: 3,
          title: 'Issue B',
          body: null,
          html_url: 'https://github.com/octo/repo/issues/3',
          user: null,
          labels: ['feature'],
        },
      ]));
    };

    const issues = await fetchOpenExternalIssues(source(), fakeFetch);
    expect(issues.map((issue) => [issue.externalId, issue.externalNumber, issue.title])).toEqual([
      ['10', '1', 'Issue A'],
      ['12', '3', 'Issue B'],
    ]);
    expect(issues[0]?.labels).toEqual(['bug']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.auth).toBe('Bearer token');
  });

  test('GitLab Self-Managed 使用实例子路径、URL 编码项目路径与 X-Next-Page', async () => {
    const config = source({
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.example/gitlab/group/repo.git',
      instanceUrl: 'https://gitlab.example/gitlab',
    });
    expect(externalIssueSourceKey(config)).toBe('gitlab:gitlab.example/gitlab/group/repo');
    const calls: string[] = [];
    const fakeFetch: ExternalIssueFetch = async (input, init) => {
      calls.push(String(input));
      expect(new Headers(init?.headers).get('private-token')).toBe('token');
      if (calls.length === 1) {
        return new Response(JSON.stringify([
          {
            id: 20,
            iid: 7,
            title: 'GitLab issue',
            description: '详情',
            web_url: 'https://gitlab.example/gitlab/group/repo/-/issues/7',
            author: { username: 'bob' },
            labels: ['backend'],
          },
        ]), { headers: { 'x-next-page': '2' } });
      }
      return new Response('[]');
    };

    const issues = await fetchOpenExternalIssues(config, fakeFetch);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ externalId: '20', externalNumber: '7', author: 'bob' });
    expect(calls[0]).toContain('/gitlab/api/v4/projects/group%2Frepo/issues');
    expect(calls[1]).toContain('page=2');
  });

  test('未配置 token 时不发请求', async () => {
    let called = false;
    await expect(fetchOpenExternalIssues(source({ apiToken: null }), async () => {
      called = true;
      return new Response('[]');
    })).rejects.toThrow('请先配置远端 API token');
    expect(called).toBe(false);
  });

  test('远端非 2xx 响应保留状态与截断后的技术详情', async () => {
    await expect(
      fetchOpenExternalIssues(source(), async () =>
        new Response('{"message":"Bad credentials"}', { status: 401 }),
      ),
    ).rejects.toMatchObject({
      status: 401,
      details: '{"message":"Bad credentials"}',
    });
  });
});
