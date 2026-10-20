import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  ClaudeSession, SessionClosedError, TurnLimitError,
  type AgentEvent, type PermissionDecision, type PermissionRequest,
} from './claude.js';
import { parseFeishuSecret } from './platform.js';
import { randomToken, sha256, type Binding, type Store } from './store.js';

/**
 * Feishu replaces an @-mention with a placeholder such as `@_user_1` in the
 * message text, with the real id only present in `mentions`. Passing those
 * placeholders to the agent is noise, and `/remember @_user_1 ...` would store
 * it as content, so strip them before routing the message.
 */
export function stripMentions(text: string, mentions: any[]): string {
  let out = text;
  for (const mention of mentions) {
    const key = typeof mention?.key === 'string' ? mention.key : '';
    if (key) out = out.split(key).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function chunkText(text: string, size = 3500): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

function summarize(req: PermissionRequest, max = 900): string {
  const input = req.input ?? {};
  const parts: string[] = [];
  if (input.command) parts.push(String(input.command));
  if (input.file_path) parts.push(String(input.file_path));
  if (input.path) parts.push(String(input.path));
  if (input.url) parts.push(String(input.url));
  if (input.query) parts.push(String(input.query));
  const text = parts.length ? parts.join('\n') : JSON.stringify(input);
  return text.replace(/```/g, "'''").slice(0, max);
}

function permissionCard(id: string, req: PermissionRequest) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'WardenDeck 权限请求' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**工具**：\`${req.toolName}\`\n**参数**：\n\`\`\`\n${summarize(req)}\n\`\`\``,
        },
      },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '允许一次' }, type: 'primary', value: { aw: id, d: 'allow_once' } },
          { tag: 'button', text: { tag: 'plain_text', content: '30 分钟内允许' }, value: { aw: id, d: 'allow_ttl' } },
          { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: { aw: id, d: 'deny' } },
        ],
      },
    ],
  };
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

/** Pull `AW_ATTACH: /path` lines out of the final answer. */
function extractAttachments(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*AW_ATTACH\s*[:：]\s*(.+?)\s*$/i);
    if (!m) {
      kept.push(line);
      continue;
    }
    const p = m[1].replace(/^[`'"]+|[`'"]+$/g, '').trim();
    if (!p) continue;
    try {
      const abs = path.resolve(p);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size === 0 || st.size > 10 * 1024 * 1024) continue;
      if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) continue;
      if (!files.includes(abs) && files.length < 10) files.push(abs);
    } catch { /* skip missing file */ }
  }
  return { text: kept.join('\n').trim(), files };
}

function formatEvent(event: AgentEvent): string {
  if (event.type === 'thinking') return '';
  if (event.type === 'tool_result') {
    if (!event.isError) return '';
    return `⚠️ 工具返回错误\n${event.text.slice(0, 300)}`;
  }
  const input = event.input ?? {};
  switch (event.name) {
    case 'Bash':
      return `🔧 Bash\n${String(input.command ?? '').slice(0, 600)}`;
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `🔧 ${event.name}\n${String(input.file_path ?? '')}`;
    case 'Read':
      return `📖 读取\n${String(input.file_path ?? '')}`;
    case 'Grep':
    case 'Glob':
      return `🔍 ${event.name}\n${String(input.pattern ?? input.path ?? '')}`;
    case 'WebFetch':
      return `🌐 访问\n${String(input.url ?? '')}`;
    default:
      return `🔧 ${event.name}\n${JSON.stringify(input).slice(0, 300)}`;
  }
}

function cardJSON(status: string, log: string, answer: string, template: string) {
  const body = [status, log, answer].filter(Boolean).join('\n\n');
  return {
    // update_multi lets the bot patch this card after sending it.
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: 'WardenDeck' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: body.replace(/```/g, "'''").slice(0, 24_000) },
      },
    ],
  };
}

async function replyText(client: Lark.Client, messageId: string, text: string) {
  const res = await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text }) },
  });
  if (res?.code && res.code !== 0) throw new Error(res.msg ?? `code ${res.code}`);
}

async function replyChunks(client: Lark.Client, messageId: string, chatId: string, text: string) {
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await replyText(client, messageId, chunks[i]);
      continue;
    }
    const res = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunks[i] }) },
    });
    if (res?.code && res.code !== 0) throw new Error(res.msg ?? `code ${res.code}`);
  }
}

/**
 * One card per incoming message, posted as a reply so everything appears
 * directly under the user's message. Progress and the final answer are
 * patched into that same card instead of scattering separate messages.
 */
export class TurnCard {
  private log: string[] = [];
  private answer = '';
  private template = 'blue';
  private timer?: NodeJS.Timeout;
  private lastPatch = 0;
  private chain: Promise<void> = Promise.resolve();
  private done = false;
  private readonly started = Date.now();

  private constructor(
    private client: Lark.Client,
    private replyTo: string,
    private chatId: string,
    private cardId: string,
    private status: string,
  ) {}

  static async open(client: Lark.Client, replyTo: string, chatId: string, status: string): Promise<TurnCard> {
    const card = new TurnCard(client, replyTo, chatId, '', status);
    try {
      const res = await client.im.v1.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: 'interactive', content: JSON.stringify(cardJSON(status, '', '', 'blue')) },
      });
      if (res?.code && res.code !== 0) throw new Error(res.msg ?? `code ${res.code}`);
      card.cardId = String((res as any)?.data?.message_id ?? '');
      if (!card.cardId) throw new Error('card message_id missing');
    } catch (err) {
      // Card unavailable: fall back to plain replies, still threaded under the message.
      console.error('[feishu] card open:', err instanceof Error ? err.message : err);
      await replyText(client, replyTo, status).catch(() => {});
    }
    return card;
  }

  status_(text: string) {
    this.status = text;
    this.touch();
  }

  progress(line: string) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.log.push(`${stamp} ${line}`);
    if (this.log.length > 15) this.log.shift();
    if (!this.cardId) {
      this.chain = this.chain.then(() => replyText(this.client, this.replyTo, line)).catch(() => {});
      return;
    }
    this.touch();
  }

  private elapsed() {
    return Math.round((Date.now() - this.started) / 1000);
  }

  async finish(text: string) {
    return this.close(`✅ 完成 · ${this.elapsed()}s`, 'green', text);
  }

  async fail(text: string) {
    return this.close(`❌ 执行失败 · ${this.elapsed()}s`, 'red', text);
  }

  private async close(status: string, template: string, answer: string) {
    if (this.done) return;
    this.done = true;
    this.status = status;
    this.template = template;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    if (!this.cardId) {
      await this.chain;
      if (answer) await replyChunks(this.client, this.replyTo, this.chatId, answer).catch(() => {});
      return;
    }

    const limit = 18_000;
    this.answer = answer.slice(0, limit);
    this.queuePatch();
    await this.chain;
    if (answer.length > limit) {
      await replyChunks(this.client, this.replyTo, this.chatId, answer.slice(limit)).catch(() => {});
    }
  }

  private touch() {
    if (!this.cardId || this.done) return;
    const wait = Math.max(0, 1_200 - (Date.now() - this.lastPatch));
    if (wait === 0) {
      this.queuePatch();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.queuePatch();
    }, wait);
    this.timer.unref();
  }

  private queuePatch() {
    if (!this.cardId) return;
    this.lastPatch = Date.now();
    const content = JSON.stringify(cardJSON(
      this.status,
      this.log.join('\n\n').slice(-8_000),
      this.answer,
      this.template,
    ));
    this.chain = this.chain
      .then(async () => {
        const res = await this.client.im.v1.message.patch({
          path: { message_id: this.cardId },
          data: { content },
        });
        if (res?.code && res.code !== 0) throw new Error(res.msg ?? `code ${res.code}`);
      })
      .catch(err => console.error('[feishu] card patch:', err instanceof Error ? err.message : err));
  }
}

interface Active {
  ws: Lark.WSClient;
  client: Lark.Client;
}

interface SessionEntry {
  session: ClaudeSession;
  mode: string;
  memory: string;
}

interface Approval {
  id: string;
  resolve: (d: PermissionDecision) => void;
  requester: string;
  chatId: string;
  client: Lark.Client;
  userMessageId: string;
  cardId: string;
  toolName: string;
  timer: NodeJS.Timeout;
}

/**
 * After a decision the card must shrink out of the way: the chat should read
 * as a short one-line receipt, not another full-height card. A collapsed
 * collapsible panel keeps the detail one tap away without taking space.
 */
function approvalResultCard(toolName: string, decision: PermissionDecision) {
  const allow = decision.behavior === 'allow';
  const scope = allow
    ? (decision.allowForMinutes ? `已允许 ${decision.allowForMinutes} 分钟` : '已允许本次')
    : '已拒绝';
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      {
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: { tag: 'plain_text', content: `${allow ? '✅' : '🚫'} ${scope} · ${toolName}` },
          vertical_align: 'center',
          icon: {
            tag: 'standard_icon',
            token: 'down-small-ccm_outlined',
            size: '16px 16px',
          },
          icon_position: 'right',
          icon_expanded_angle: -180,
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: allow ? '操作已放行，Agent 继续执行。' : '该操作不会执行。',
            },
          },
        ],
      },
    ],
  };
}

/** Minimal one-line receipt, used if the client rejects the collapsible panel. */
function approvalPlainResultCard(toolName: string, decision: PermissionDecision) {
  const allow = decision.behavior === 'allow';
  const scope = allow
    ? (decision.allowForMinutes ? `已允许 ${decision.allowForMinutes} 分钟` : '已允许本次')
    : '已拒绝';
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `${allow ? '✅' : '🚫'} ${scope} · ${toolName}` }],
      },
    ],
  };
}

export class FeishuConnectors {
  private active = new Map<string, Active>();
  private seen = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private sessions = new Map<string, SessionEntry>();
  private approvals = new Map<string, Approval>();
  private botIds = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private topology = '';
  private syncing?: Promise<void>;

  constructor(private store: Store) {}

  async start() {
    await this.sync();
    // CLI changes (a new binding, a rotated credential) bypass the HTTP API
    // and therefore `restart()`. Poll the topology so the first binding added
    // while the service is running connects without a manual restart.
    this.watchdog = setInterval(() => {
      try {
        if (this.computeTopology() !== this.topology) {
          console.log('[feishu] bindings changed, reloading connections');
          void this.sync().catch(err => console.error('[feishu] reload:', err.message));
        }
      } catch (err) {
        console.error('[feishu] topology check:', err instanceof Error ? err.message : err);
      }
    }, 5000);
    this.watchdog.unref();
  }

  stop() {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.stopConnections();
  }

  private stopConnections() {
    for (const a of this.active.values()) a.ws.close({ force: true });
    this.active.clear();
    for (const entry of this.sessions.values()) entry.session.close();
    this.sessions.clear();
    for (const [id] of this.approvals) {
      this.resolveApproval(id, { behavior: 'deny', message: '服务重启，审批已取消。' }, 'system');
    }
  }

  restart() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.sync().catch(err => console.error('[feishu] restart:', err.message));
    }, 300);
  }

  /** Credential set and secret fingerprints; changes require a reconnect. */
  private computeTopology(): string {
    const credentials = [...new Set(
      this.store.snapshot().bindings
        .filter(b => b.platform === 'feishu' && b.enabled)
        .map(b => b.credential),
    )].sort();
    return credentials
      .map(cred => `${cred}:${sha256(this.store.getSecret(cred) ?? 'missing').slice(0, 16)}`)
      .join('|');
  }

  private sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async doSync() {
    this.stopConnections();
    const bindings = this.store.snapshot().bindings.filter(b => b.platform === 'feishu' && b.enabled);
    const byCredential = new Map<string, Binding[]>();
    for (const b of bindings) {
      const list = byCredential.get(b.credential) ?? [];
      list.push(b);
      byCredential.set(b.credential, list);
    }

    for (const [credential] of byCredential) {
      const raw = this.store.getSecret(credential);
      if (!raw) continue;
      const { appId, appSecret, domain } = parseFeishuSecret(raw);
      // Ignore obviously fake placeholders so the demo instance does not
      // spin in a reconnect loop.
      if (!appId.startsWith('cli_') || appSecret.length < 16) continue;

      const cfg = {
        appId, appSecret,
        domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.warn,
        onReady: () => console.log(`[feishu] connected ${credential} (${appId})`),
        onError: (err: Error) => console.error(`[feishu] ${credential}:`, err.message),
      };
      const client = new Lark.Client(cfg);
      // Needed to tell an @-mention of us from an @-mention of another bot.
      try {
        const info: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
        if (info?.bot?.open_id) this.botIds.set(credential, info.bot.open_id);
      } catch (err) {
        console.error(`[feishu] ${credential} bot info:`, err instanceof Error ? err.message : err);
      }
      const ws = new Lark.WSClient(cfg);
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: any) =>
          this.onMessage(client, credential, data)
            .catch(err => console.error('[feishu] message:', err.message)),
        'card.action.trigger': (data: any) => this.onCardAction(data),
      } as any);
      this.active.set(credential, { ws, client });
      ws.start({ eventDispatcher: dispatcher })
        .catch(err => console.error(`[feishu] ${credential} start:`, err.message));
    }
    this.topology = this.computeTopology();
  }

  private async onMessage(client: Lark.Client, credential: string, data: any) {
    const msg = data?.message;
    const openId = data?.sender?.sender_id?.open_id;
    if (!msg || !openId || data?.sender?.sender_type === 'app') return;

    const now = Date.now();
    const seenAt = this.seen.get(msg.message_id);
    if (seenAt && now - seenAt < 10 * 60_000) return;
    this.seen.set(msg.message_id, now);
    if (this.seen.size > 500) {
      for (const [id, ts] of this.seen) if (now - ts > 10 * 60_000) this.seen.delete(id);
    }

    const mentions: any[] = Array.isArray(msg.mentions) ? msg.mentions : [];
    const isText = msg.message_type === 'text';
    let text = '';
    if (isText) {
      try { text = JSON.parse(msg.content)?.text ?? ''; } catch { /* ignore */ }
      text = stripMentions(String(text), mentions);
    }

    // Text fallback for approvals when card callbacks are unavailable.
    const pending = text
      ? [...this.approvals.values()].find(a => a.requester === openId && a.chatId === msg.chat_id)
      : undefined;
    if (pending) {
      if (/^(1|allow|允许)$/i.test(text)) {
        this.resolveApproval(pending.id, { behavior: 'allow' }, openId);
        await replyText(client, msg.message_id, '已允许，正在继续执行。');
        return;
      }
      if (/^(2|allow30|允许30分钟|30分钟)$/i.test(text)) {
        this.resolveApproval(pending.id, { behavior: 'allow', allowForMinutes: 30 }, openId);
        await replyText(client, msg.message_id, '已允许，30 分钟内不再逐项确认。');
        return;
      }
      if (/^(3|deny|拒绝)$/i.test(text)) {
        this.resolveApproval(pending.id, { behavior: 'deny', message: '用户拒绝了该操作。' }, openId);
        await replyText(client, msg.message_id, '已拒绝。');
        return;
      }
    }

    const isP2p = msg.chat_type === 'p2p';
    const binding = this.store.snapshot().bindings.find(b =>
      b.platform === 'feishu' && b.enabled && b.credential === credential &&
      // open_id is a private-chat fallback only: in a group it would make the
      // bot answer every chat the user is in, including other bots' chats.
      (b.channels.includes(msg.chat_id) || (isP2p && b.channels.includes(openId))));
    if (!binding) {
      this.store.audit(openId, 'message.unmatched', msg.chat_id, text.slice(0, 500));
      return;
    }
    if (!binding.allowed_users.includes(openId)) {
      this.store.audit(openId, 'message.denied', binding.project, text.slice(0, 500));
      await replyText(client, msg.message_id, '未授权：请联系管理员在 WardenDeck 中绑定你的 open_id。');
      return;
    }
    if (binding.mention_only && !isP2p) {
      // Only answer when OUR bot is mentioned. A group may contain several
      // bots; "@" in the text alone also matches mentions of someone else.
      const botId = this.botIds.get(credential);
      const mentioned = botId
        ? mentions.some(m => (m?.id?.open_id ?? m?.open_id) === botId)
        : mentions.length > 0;
      if (!mentioned) {
        this.store.audit(openId, 'message.not_mentioned', msg.chat_id, text);
        return;
      }
    }

    // Authorization happens before any reply, so an unbound or unauthorized
    // chat never gets a response, including for unsupported message types.
    if (!isText) {
      await replyText(client, msg.message_id, '目前只支持文本消息。');
      return;
    }
    if (!text) {
      await replyText(client, msg.message_id, '你好，需要我做什么？');
      return;
    }

    const key = this.sessionKey(binding, msg.chat_id);
    if (await this.handleMemoryCommand(client, binding, msg, openId, text, key)) return;
    if (/^\/(stop|cancel)$/i.test(text)) {
      // Cancel pending approvals too, otherwise a pending card would stay
      // clickable after the run it belongs to is gone.
      for (const [id, a] of [...this.approvals]) {
        if (a.chatId === msg.chat_id) {
          this.resolveApproval(id, { behavior: 'deny', message: '用户已停止任务。' }, openId);
        }
      }
      this.sessions.get(key)?.session.close(true);
      this.sessions.delete(key);
      this.store.audit(openId, 'agent.stop', binding.project, 'ok');
      await replyText(client, msg.message_id, '已停止当前任务。');
      return;
    }

    this.store.audit(openId, 'message.inbound', binding.project, text.slice(0, 500));
    const busy = this.queues.has(key);
    // The card is itself a reply, so "执行中" shows up under the user's message
    // and gets updated in place as the run progresses.
    const card = await TurnCard.open(client, msg.message_id, msg.chat_id,
      busy ? '⏳ 已排队，前一个任务完成后执行…' : '⏳ 正在执行…');
    await this.enqueue(key, () => this.runAndReply(client, binding, msg, openId, text, card));
  }

  private sessionKey(binding: Binding, chatId: string): string {
    // The assistant is part of the key: native agent sessions must never be
    // reused across bots, even when they share a credential and a chat.
    return `${binding.assistant_id}:${binding.credential}:${binding.project}:${chatId}`;
  }

  private memoryScopes(binding: Binding, chatId: string, userId: string) {
    return [
      { type: 'assistant' as const, id: '' },
      { type: 'project' as const, id: binding.project },
      { type: 'chat' as const, id: chatId },
      { type: 'user' as const, id: userId },
    ];
  }

  /**
   * Chat-side memory commands. They are handled before the message reaches the
   * agent, and writes default to the narrowest sensible scope: P2P chats go to
   * the user, group chats go to the chat. Promoting to assistant scope is an
   * admin action (CLI / console), not something a chat participant can do.
   */
  private async handleMemoryCommand(
    client: Lark.Client, binding: Binding, msg: any, openId: string, text: string, key: string,
  ): Promise<boolean> {
    const assistant = binding.assistant_id || 'default';
    const p2p = msg.chat_type === 'p2p';
    const scopes = this.memoryScopes(binding, msg.chat_id, openId);

    if (/^\/remember(?:\s|$)/i.test(text)) {
      const content = text.replace(/^\/remember\s*/i, '').trim();
      if (!content) {
        await replyText(client, msg.message_id, '用法：/remember <要记住的内容>');
        return true;
      }
      const item = this.store.addMemory({
        assistant_id: assistant,
        scope_type: p2p ? 'user' : 'chat',
        scope_id: p2p ? openId : msg.chat_id,
        kind: 'fact', content, source: `feishu:${openId}`, actor: openId,
      });
      this.resetSession(key);
      await replyText(client, msg.message_id,
        `已记住（#${item.id}，${p2p ? '个人' : '本会话'}记忆）。下一条消息会带着它执行。`);
      return true;
    }

    if (/^\/memory(?:\s|$)/i.test(text)) {
      const items = this.store.memoriesFor(assistant, scopes, 20);
      if (!items.length) {
        await replyText(client, msg.message_id, '当前机器人还没有可用的长期记忆。用 /remember 添加。');
        return true;
      }
      const labels: Record<string, string> = { assistant: '机器人', project: '项目', chat: '会话', user: '个人' };
      const body = items.map(m =>
        `#${m.id} [${labels[m.scope_type]}/` + `${m.kind}] ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`)
        .join('\n');
      await replyText(client, msg.message_id, `长期记忆（${assistant}）：\n${body}`);
      return true;
    }

    if (/^\/forget(?:\s|$)/i.test(text)) {
      const id = Number(text.replace(/^\/forget\s*/i, '').trim());
      if (!Number.isInteger(id)) {
        await replyText(client, msg.message_id, '用法：/forget <记忆编号>');
        return true;
      }
      const visible = this.store.memoriesFor(assistant, scopes, 500).some(m => m.id === id);
      if (!visible) {
        await replyText(client, msg.message_id, `记忆 #${id} 不在当前作用域内，无法删除。`);
        return true;
      }
      this.store.forgetMemory(assistant, id, openId);
      this.resetSession(key);
      await replyText(client, msg.message_id, `已删除记忆 #${id}。`);
      return true;
    }

    return false;
  }

  private resetSession(key: string) {
    // Close the process so the next turn rebuilds the system prompt with the
    // updated memory; the native session id is kept for --resume.
    this.sessions.get(key)?.session.close();
    this.sessions.delete(key);
  }

  private enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn).catch(err => {
      console.error('[feishu] run:', err.message);
    }).finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    this.queues.set(key, next);
    return next;
  }

  private async runAndReply(
    client: Lark.Client, binding: Binding, msg: any, openId: string, text: string, card: TurnCard,
  ) {
    const project = this.store.snapshot().projects.find(p => p.name === binding.project);
    if (!project) {
      await card.fail(`[WardenDeck] 项目 ${binding.project} 不存在。`);
      return;
    }
    if (project.agent !== 'claudecode') {
      await card.fail(`[WardenDeck] 项目 ${project.name} 使用 ${project.agent}，执行适配尚未接入。`);
      return;
    }

    card.status_('⏳ 正在执行…');
    const key = this.sessionKey(binding, msg.chat_id);
    const mode = project.permission_mode || 'default';
    const prior = this.store.getAgentSession(key);
    const memory = this.store.memoryPrompt(
      binding.assistant_id, this.memoryScopes(binding, msg.chat_id, openId), text);
    let entry = this.sessions.get(key);
    if (!entry || entry.mode !== mode || entry.memory !== memory) {
      const resumeId = entry?.session.sessionID || prior?.session_id || '';
      entry?.session.close();
      entry = {
        session: new ClaudeSession(project.workdir, mode, resumeId, [this.store.dir], memory),
        mode, memory,
      };
      this.sessions.set(key, entry);
    }

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      card.status_(`⏳ 仍在执行…（已 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
    }, 60_000);
    heartbeat.unref();

    const onPermission = async (req: PermissionRequest) => {
      card.status_('⏳ 等待授权…');
      try {
        return await this.requestApproval(client, msg, openId, req);
      } finally {
        card.status_('⏳ 正在执行…');
      }
    };
    let progressCount = 0;
    const onEvent = (event: AgentEvent) => {
      if (progressCount >= 15) return;
      const line = formatEvent(event);
      if (!line) return;
      progressCount++;
      card.progress(line);
    };
    let out = '';
    try {
      out = await entry.session.ask(text, onPermission, onEvent);
    } catch (err) {
      // A stale --resume id is the most common recoverable failure, but a
      // per-turn limit must stop the message rather than retry it — retrying
      // would hand the same message a fresh quota. A closed session is a
      // user-requested stop: retrying would restart the task they cancelled.
      if (err instanceof TurnLimitError || err instanceof SessionClosedError) {
        clearInterval(heartbeat);
        await this.failTurn(card, binding, err);
        return;
      }
      if (prior?.session_id) {
        entry.session.close();
        entry = {
          session: new ClaudeSession(project.workdir, mode, '', [this.store.dir], memory),
          mode, memory,
        };
        this.sessions.set(key, entry);
        try {
          out = await entry.session.ask(text, onPermission, onEvent);
        } catch (err2) {
          clearInterval(heartbeat);
          await this.failTurn(card, binding, err2);
          return;
        }
      } else {
        clearInterval(heartbeat);
        await this.failTurn(card, binding, err);
        return;
      }
    }

    if (entry.session.sessionID) this.store.setAgentSession(key, 'claudecode', entry.session.sessionID);
    this.store.audit('wardendeck', 'agent.run', binding.project, entry.session.sessionID || 'no-session');

    const { text: answer, files } = extractAttachments(out);
    const replyTextOut = answer || (files.length
      ? `已发送 ${files.length} 张图片。`
      : '（Claude Code 没有返回文本）');
    try {
      await card.finish(replyTextOut);
      this.store.audit('wardendeck', 'message.outbound', binding.project, replyTextOut.slice(0, 500));
      if (files.length) await this.sendAttachments(client, msg, binding.project, files);
    } catch (err) {
      this.store.audit('wardendeck', 'message.outbound', binding.project,
        err instanceof Error ? err.message : String(err));
    }
    clearInterval(heartbeat);
  }

  /** Upload local images and send them with our own bot (never another app). */
  private async sendAttachments(client: Lark.Client, msg: any, project: string, files: string[]) {
    for (const file of files) {
      try {
        const up: any = await client.im.v1.image.create({
          data: { image_type: 'message', image: fs.createReadStream(file) },
        });
        const key = up?.image_key ?? up?.data?.image_key;
        if (!key) throw new Error('上传图片未返回 image_key');
        const res = await client.im.v1.message.reply({
          path: { message_id: msg.message_id },
          data: { msg_type: 'image', content: JSON.stringify({ image_key: key }) },
        });
        if (res?.code && res.code !== 0) throw new Error(res.msg ?? `code ${res.code}`);
        this.store.audit('wardendeck', 'message.attachment', project, path.basename(file));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[feishu] attachment:', message);
        this.store.audit('wardendeck', 'message.attachment.error', project, `${path.basename(file)}: ${message}`);
      }
    }
  }

  private async failTurn(card: TurnCard, binding: Binding, err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = err instanceof TurnLimitError || err instanceof SessionClosedError
      ? detail
      : `Claude Code 执行失败：${detail}`;
    await card.fail(`[WardenDeck] ${message}`).catch(() => {});
    this.store.audit('wardendeck', 'agent.error', binding.project, message);
  }

  private async requestApproval(client: Lark.Client, msg: any, openId: string, req: PermissionRequest): Promise<PermissionDecision> {
    const id = randomToken(6);
    let cardId = '';
    try {
      const res = await client.im.v1.message.reply({
        path: { message_id: msg.message_id },
        data: { msg_type: 'interactive', content: JSON.stringify(permissionCard(id, req)) },
      });
      if (res?.code && res.code !== 0) throw new Error(res.msg ?? `code ${res.code}`);
      cardId = String((res as any)?.data?.message_id ?? '');
    } catch (err) {
      console.error('[feishu] permission card:', err instanceof Error ? err.message : err);
    }
    // Only when the card could not be sent: otherwise this repeats the same
    // content in the chat and doubles the vertical space the request takes.
    if (!cardId) {
      await replyText(client, msg.message_id,
        `需要权限：${req.toolName}\n${summarize(req, 500)}\n回复 1 允许一次 / 2 允许 30 分钟 / 3 拒绝。`).catch(() => {});
    }
    this.store.audit('wardendeck', 'approval.request', req.toolName, summarize(req, 500));

    return new Promise<PermissionDecision>(resolve => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve({ behavior: 'deny', message: '审批超时，已拒绝。' });
        this.store.audit('wardendeck', 'approval.expire', id, req.toolName);
      }, 5 * 60_000);
      timer.unref();
      this.approvals.set(id, {
        id, resolve, requester: openId, chatId: msg.chat_id,
        client, userMessageId: msg.message_id, cardId, toolName: req.toolName, timer,
      });
    });
  }

  private onCardAction(data: any) {
    const openId = data?.operator?.open_id ?? data?.operator?.openId ?? data?.open_id;
    let value = data?.action?.value ?? {};
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = {}; }
    }
    const id = String(value.aw ?? '');
    const d = String(value.d ?? '');
    if (!id || !d) return;
    const approval = this.approvals.get(id);
    if (!approval) return { toast: { type: 'warning', content: '审批已失效' } };
    if (openId !== approval.requester) {
      this.store.audit(openId ?? 'unknown', 'approval.denied_actor', id, d);
      return { toast: { type: 'error', content: '只有发起人可以审批' } };
    }
    const allow = d === 'allow_once' || d === 'allow_ttl';
    this.resolveApproval(id, {
      behavior: allow ? 'allow' : 'deny',
      allowForMinutes: d === 'allow_ttl' ? 30 : undefined,
      message: '用户拒绝了该操作。',
    }, openId);
    return { toast: { type: 'success', content: allow ? '已允许' : '已拒绝' } };
  }

  private resolveApproval(id: string, decision: PermissionDecision, actor: string) {
    const approval = this.approvals.get(id);
    if (!approval) return;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    approval.resolve(decision);
    const result = decision.behavior === 'allow'
      ? (decision.allowForMinutes ? `allow_${decision.allowForMinutes}m` : 'allow_once')
      : 'deny';
    this.store.audit(actor, 'approval.decide', id, result);
    const allow = decision.behavior === 'allow';
    if (approval.cardId) {
      const patch = (content: object) => approval.client.im.v1.message.patch({
        path: { message_id: approval.cardId },
        data: { content: JSON.stringify(content) },
      });
      // Replace the buttons with the outcome so the card cannot be clicked again.
      // Older clients that don't render collapsible panels get a one-line note.
      patch(approvalResultCard(approval.toolName, decision)).catch(err => {
        console.error('[feishu] approval card patch:', err instanceof Error ? err.message : err);
        return patch(approvalPlainResultCard(approval.toolName, decision));
      }).catch(err => console.error('[feishu] approval card patch (plain):',
        err instanceof Error ? err.message : err));
      // The patched card already states the outcome; a separate message is noise.
      return;
    }
    // No card (card send failed): the text reply is the only confirmation left.
    const text = allow
      ? (decision.allowForMinutes
        ? `已允许 ${decision.allowForMinutes} 分钟内的工具调用。`
        : '已允许本次操作。')
      : '已拒绝本次操作。';
    replyText(approval.client, approval.userMessageId, text).catch(() => {});
  }
}
