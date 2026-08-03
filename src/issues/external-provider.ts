/**
 * issues/external-provider —— Git remote 规范化与 GitHub/GitLab 开放 issue 读取。
 * 只做远端协议适配，不读写 PandaDOS 数据库。
 */
import type {
  ExternalIssueProvider,
  ExternalIssueSourceConfig,
} from '../core/types';

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ParsedGitRemote {
  originalUrl: string;
  safeUrl: string;
  host: string;
  port: string;
  repoPath: string;
  transport: 'http' | 'ssh' | 'git';
}

export interface ExternalIssueCandidate {
  provider: ExternalIssueProvider;
  sourceKey: string;
  externalId: string;
  externalNumber: string;
  title: string;
  body: string;
  url: string;
  author: string | null;
  labels: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** 只依赖 fetch 的请求函数，不要求 Bun 全局 fetch 附带的 preconnect 静态属性。 */
export type ExternalIssueFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ExternalIssueProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'ExternalIssueProviderError';
  }
}

function cleanRepoPath(value: string): string {
  const path = value.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('远端仓库路径无效');
  }
  return path;
}

/** 支持 http(s)、ssh://、git:// 与 git@host:group/repo.git。 */
export function parseGitRemoteUrl(raw: string): ParsedGitRemote {
  const value = raw.trim();
  if (!value) throw new Error('Git remote URL 为空');
  const scp = value.match(/^(?:([^@/:\s]+)@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/);
  if (scp && !value.includes('://')) {
    const host = scp[2]!.replace(/^\[|\]$/g, '').toLowerCase();
    return {
      originalUrl: value,
      safeUrl: `${scp[1] ? `${scp[1]}@` : ''}${scp[2]}:${scp[3]}`,
      host,
      port: '',
      repoPath: cleanRepoPath(scp[3]!),
      transport: 'ssh',
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Git remote URL 格式无效');
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) {
    throw new Error('Git remote URL 仅支持 http(s)、ssh 或 git 协议');
  }
  if (!url.hostname) throw new Error('Git remote URL 缺少主机名');
  const safe = new URL(url.toString());
  safe.password = '';
  if (safe.protocol === 'http:' || safe.protocol === 'https:') {
    safe.username = '';
  }
  return {
    originalUrl: value,
    safeUrl: safe.toString(),
    host: url.hostname.toLowerCase(),
    port: url.port,
    repoPath: cleanRepoPath(decodeURIComponent(url.pathname)),
    transport: url.protocol.startsWith('http') ? 'http' : url.protocol === 'git:' ? 'git' : 'ssh',
  };
}

export function normalizeInstanceUrl(
  provider: ExternalIssueProvider,
  parsed: ParsedGitRemote,
  requested?: string,
): string {
  if (provider === 'github') {
    if (parsed.host !== 'github.com') throw new Error('GitHub 来源必须绑定 github.com 仓库');
    return 'https://github.com';
  }
  if (!requested?.trim()) {
    const port = parsed.transport === 'http' && parsed.port ? `:${parsed.port}` : '';
    return `https://${parsed.host}${port}`;
  }
  let url: URL;
  try {
    url = new URL(requested.trim());
  } catch {
    throw new Error('GitLab 实例地址必须是有效的 http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('GitLab 实例地址必须是无凭据、无查询参数的 http(s) URL');
  }
  if (url.hostname.toLowerCase() !== parsed.host) {
    throw new Error('GitLab 实例地址必须与 Git remote 使用同一主机');
  }
  return url.toString().replace(/\/+$/, '');
}

function repoPathForSource(source: ExternalIssueSourceConfig): string {
  const parsed = parseGitRemoteUrl(source.remoteUrl);
  if (source.provider !== 'gitlab') return parsed.repoPath;
  const instancePath = new URL(source.instanceUrl).pathname.replace(/^\/+|\/+$/g, '');
  return instancePath && parsed.repoPath.startsWith(`${instancePath}/`)
    ? parsed.repoPath.slice(instancePath.length + 1)
    : parsed.repoPath;
}

export function externalIssueSourceKey(source: ExternalIssueSourceConfig): string {
  const instance = new URL(source.instanceUrl);
  const basePath = instance.pathname.replace(/\/+$/, '');
  return `${source.provider}:${instance.host.toLowerCase()}${basePath}/${repoPathForSource(source)}`
    .toLowerCase();
}

function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2]?.split(/\s+/).includes('next')) return match[1]!;
  }
  return null;
}

async function getJson(
  fetchImpl: ExternalIssueFetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ values: unknown[]; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ExternalIssueProviderError(
      '连接远端 issue 服务失败',
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ExternalIssueProviderError(
      `远端 issue 服务返回 HTTP ${response.status}`,
      response.status,
      text.slice(0, 500),
    );
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    throw new ExternalIssueProviderError('远端 issue 服务返回了无效 JSON', response.status, text.slice(0, 500));
  }
  if (!Array.isArray(data)) {
    throw new ExternalIssueProviderError('远端 issue 服务返回的数据格式无效', response.status);
  }
  return { values: data, headers: response.headers };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item : text((item as { name?: unknown })?.name))
    .filter(Boolean);
}

export async function fetchOpenExternalIssues(
  source: ExternalIssueSourceConfig,
  fetchImpl: ExternalIssueFetch = fetch,
): Promise<ExternalIssueCandidate[]> {
  if (!source.apiToken) throw new ExternalIssueProviderError('请先配置远端 API token');
  const repoPath = repoPathForSource(source);
  const sourceKey = externalIssueSourceKey(source);
  const out: ExternalIssueCandidate[] = [];

  if (source.provider === 'github') {
    const parts = repoPath.split('/');
    if (parts.length !== 2) throw new ExternalIssueProviderError('GitHub 仓库路径必须是 owner/repo');
    let url: string | null =
      `https://api.github.com/repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`
      + `/issues?state=open&per_page=${PAGE_SIZE}&page=1`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const response = await getJson(fetchImpl, url, {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${source.apiToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PandaDOS',
      });
      for (const raw of response.values) {
        const item = raw as Record<string, unknown>;
        if (item.pull_request != null) continue;
        const id = item.id;
        const number = item.number;
        if ((typeof id !== 'number' && typeof id !== 'string') || typeof number !== 'number') continue;
        out.push({
          provider: 'github',
          sourceKey,
          externalId: String(id),
          externalNumber: String(number),
          title: text(item.title),
          body: text(item.body),
          url: text(item.html_url),
          author: nullableText((item.user as { login?: unknown } | null)?.login),
          labels: labelsOf(item.labels),
          createdAt: nullableText(item.created_at),
          updatedAt: nullableText(item.updated_at),
        });
      }
      url = nextLink(response.headers.get('link'));
    }
    if (url) throw new ExternalIssueProviderError('GitHub issue 分页超过安全上限');
    return out;
  }

  const base = source.instanceUrl.replace(/\/+$/, '');
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const url = `${base}/api/v4/projects/${encodeURIComponent(repoPath)}/issues`
      + `?state=opened&per_page=${PAGE_SIZE}&page=${page}`;
    const response = await getJson(fetchImpl, url, {
      Accept: 'application/json',
      'PRIVATE-TOKEN': source.apiToken,
      'User-Agent': 'PandaDOS',
    });
    for (const raw of response.values) {
      const item = raw as Record<string, unknown>;
      const id = item.id;
      const iid = item.iid;
      if ((typeof id !== 'number' && typeof id !== 'string') || typeof iid !== 'number') continue;
      out.push({
        provider: 'gitlab',
        sourceKey,
        externalId: String(id),
        externalNumber: String(iid),
        title: text(item.title),
        body: text(item.description),
        url: text(item.web_url),
        author: nullableText((item.author as { username?: unknown } | null)?.username),
        labels: labelsOf(item.labels),
        createdAt: nullableText(item.created_at),
        updatedAt: nullableText(item.updated_at),
      });
    }
    const next = response.headers.get('x-next-page')?.trim();
    if (next) {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= page) {
        throw new ExternalIssueProviderError('GitLab 返回了无效的分页信息');
      }
      page = parsed - 1;
      continue;
    }
    if (response.values.length < PAGE_SIZE) return out;
  }
  throw new ExternalIssueProviderError('GitLab issue 分页超过安全上限');
}
