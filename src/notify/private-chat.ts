import type { Database } from 'bun:sqlite';
import {
  accessibleChatProjects, resolveChatProject, userByFeishuOpenid, userI18n,
  type ChatProject, type NotifyTarget,
} from './router';
import type { MessageKey } from '../../shared/i18n/messages';

export interface PrivateChatDeps {
  db: Database;
  answer(userId: number, projectId: number, question: string): Promise<string>;
  send(target: NotifyTarget, text: string): Promise<void>;
  /** False after the owning connection has been replaced or disabled. */
  isActive?(): boolean;
}

/** In-memory project selection only; the answer provider owns any conversation history. */
export class PrivateChat {
  private readonly selected = new Map<number, { projectId: number; openid: string }>();
  private readonly pending = new Map<number, Promise<void>>();

  constructor(private readonly deps: PrivateChatDeps) {}

  handle(openid: string, text: string): Promise<void> {
    if (!openid || !this.active()) return Promise.resolve();
    const user = userByFeishuOpenid(this.deps.db, openid);
    if (!user) {
      return this.deps.send({ userId: 0, address: openid }, userI18n(this.deps.db, 0).t('feishuChat.bindFirst'));
    }
    const previous = this.pending.get(user.id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.process(user.id, openid, text.trim()));
    this.pending.set(user.id, work);
    const clean = () => { if (this.pending.get(user.id) === work) this.pending.delete(user.id); };
    void work.then(clean, clean);
    return work;
  }

  private active(): boolean { return this.deps.isActive?.() ?? true; }

  private bound(userId: number, openid: string): boolean {
    return this.active() && userByFeishuOpenid(this.deps.db, openid)?.id === userId;
  }

  private projects(userId: number): ChatProject[] {
    return accessibleChatProjects(this.deps.db, userId);
  }

  private async reply(userId: number, openid: string, key: MessageKey,
    values: Record<string, string | number> = {}, projectId?: number): Promise<void> {
    if (!this.bound(userId, openid)) return;
    if (projectId !== undefined && !this.projects(userId).some((p) => p.id === projectId)) return;
    await this.deps.send({ userId, address: openid }, userI18n(this.deps.db, userId).t(key, values));
  }

  private async list(userId: number, openid: string, ambiguous = false): Promise<void> {
    const projects = this.projects(userId);
    await this.reply(userId, openid, projects.length === 0 ? 'feishuChat.noProjects' :
      ambiguous ? 'feishuChat.ambiguous' : 'feishuChat.projects', {
      projects: projects.map((p) => `#${p.id} ${p.name}`).join('\n'),
    });
  }

  private async process(userId: number, openid: string, text: string): Promise<void> {
    if (!this.bound(userId, openid)) return;
    const projects = this.projects(userId);
    if (/^(projects|help|项目|帮助)$/i.test(text) || !text) {
      await this.list(userId, openid);
      return;
    }
    const selection = this.selected.get(userId);
    const remembered = selection?.openid === openid
      ? projects.find((p) => p.id === selection.projectId) : undefined;
    if (!remembered) this.selected.delete(userId);
    let project = remembered;
    let question = text;
    const resolved = resolveChatProject(projects, text);
    if (resolved) {
      if (resolved.matches.length === 0) {
        await this.reply(userId, openid, 'feishuChat.unavailable');
        return;
      }
      if (resolved.matches.length > 1) {
        await this.list(userId, openid, true);
        return;
      }
      project = resolved.matches[0];
      question = resolved.question;
    } else if (!project && projects.length === 1) {
      project = projects[0];
    }
    if (!project) {
      await this.list(userId, openid);
      return;
    }
    this.selected.set(userId, { projectId: project.id, openid });
    if (!question) {
      await this.reply(userId, openid, 'feishuChat.selected', { id: project.id, name: project.name }, project.id);
      return;
    }
    // Both checks are repeated after queued work and around the asynchronous answer.
    if (!this.bound(userId, openid) || !this.projects(userId).some((p) => p.id === project.id)) return;
    let answer: string;
    try {
      answer = await this.deps.answer(userId, project.id, question);
    } catch {
      await this.reply(userId, openid, 'feishuChat.failed', {}, project.id);
      return;
    }
    await this.reply(userId, openid, 'feishuChat.answer', { id: project.id, name: project.name, answer }, project.id);
  }
}
