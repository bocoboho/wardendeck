const timeout = () => AbortSignal.timeout(10_000);

export async function testPlatform(kind: string, secret: string): Promise<string> {
  if (kind === 'slack') return testSlack(secret);
  if (kind === 'telegram') return testTelegram(secret);
  if (kind === 'feishu') return testFeishu(secret);
  throw new Error(`unsupported platform ${kind}`);
}

export function parseSlackSecret(secret: string): { app: string; bot: string } {
  try {
    const v = JSON.parse(secret);
    if (v.app_token || v.bot_token) return { app: v.app_token ?? '', bot: v.bot_token ?? '' };
  } catch { /* plain text */ }
  let app = '', bot = '';
  for (const token of secret.split(/[\s,]+/)) {
    if (token.startsWith('xapp-')) app = token;
    if (token.startsWith('xoxb-')) bot = token;
  }
  return { app, bot };
}

async function slackCall(token: string, method: string, payload: Record<string, any> = {}): Promise<Record<string, any>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: timeout(),
  });
  const body = await res.json() as Record<string, any>;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  if (!body.ok) throw new Error(`${method}: ${body.error ?? 'failed'}`);
  return body;
}

async function testSlack(secret: string): Promise<string> {
  const { app, bot } = parseSlackSecret(secret);
  if (!bot) throw new Error('slack bot token (xoxb-) missing');
  const auth = await slackCall(bot, 'auth.test');
  let detail = `workspace=${auth.team ?? '?'} bot=${auth.user ?? '?'}`;
  if (app) {
    await slackCall(app, 'apps.connections.open');
    detail += ' socket=ok';
  } else {
    detail += ' socket=missing xapp- token';
  }
  return detail;
}

async function testTelegram(secret: string): Promise<string> {
  const token = secret.trim();
  if (!token || !token.includes(':')) throw new Error('invalid telegram bot token');
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: timeout() });
  const body = await res.json() as Record<string, any>;
  if (!body.ok) throw new Error(`getMe: ${body.description ?? 'failed'}`);
  return `bot=@${body.result.username} id=${body.result.id}`;
}

export interface FeishuBegin {
  deviceCode: string;
  qrUrl: string;
  interval: number;
  expiresIn: number;
  baseUrl: string;
}

export interface FeishuPoll {
  status: 'pending' | 'completed' | 'denied' | 'expired' | 'error';
  baseUrl: string;
  appId?: string;
  appSecret?: string;
  platform?: string;
  ownerOpenId?: string;
  slowDown?: boolean;
  error?: string;
}

const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS = 'https://accounts.larksuite.com';

async function feishuRegistration(base: string, action: string, params: Record<string, string> = {}) {
  const form = new URLSearchParams({ action, ...params });
  const res = await fetch(`${base}/oauth/v1/app/registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: timeout(),
  });
  return await res.json() as Record<string, any>;
}

export async function feishuBegin(): Promise<FeishuBegin> {
  const init = await feishuRegistration(FEISHU_ACCOUNTS, 'init');
  if (init.error) throw new Error(`feishu init: ${init.error_description ?? init.error}`);
  const begin = await feishuRegistration(FEISHU_ACCOUNTS, 'begin', {
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  if (begin.error) throw new Error(`feishu begin: ${begin.error_description ?? begin.error}`);
  if (!begin.device_code || !begin.verification_uri_complete) {
    throw new Error('feishu begin: incomplete response');
  }
  return {
    deviceCode: begin.device_code,
    qrUrl: begin.verification_uri_complete,
    interval: Number(begin.interval) || 5,
    expiresIn: Number(begin.expire_in) || 300,
    baseUrl: FEISHU_ACCOUNTS,
  };
}

export async function feishuPoll(deviceCode: string, baseUrl = FEISHU_ACCOUNTS): Promise<FeishuPoll> {
  let base = baseUrl;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await feishuRegistration(base, 'poll', { device_code: deviceCode });
    const brand = String(r.user_info?.tenant_brand ?? '').toLowerCase();
    if (brand === 'lark' && base !== LARK_ACCOUNTS) {
      base = LARK_ACCOUNTS;
      continue;
    }
    if (r.client_id && r.client_secret) {
      return {
        status: 'completed', baseUrl: base,
        appId: r.client_id, appSecret: r.client_secret,
        platform: brand === 'lark' ? 'lark' : 'feishu',
        ownerOpenId: r.user_info?.open_id,
      };
    }
    const error = String(r.error ?? '');
    if (error === 'authorization_pending') return { status: 'pending', baseUrl: base };
    if (error === 'slow_down') return { status: 'pending', baseUrl: base, slowDown: true };
    if (error === 'access_denied') return { status: 'denied', baseUrl: base };
    if (error === 'expired_token') return { status: 'expired', baseUrl: base };
    if (error) return { status: 'error', baseUrl: base, error: `${error}: ${r.error_description ?? ''}` };
    return { status: 'pending', baseUrl: base };
  }
  return { status: 'pending', baseUrl: base };
}

export function parseFeishuSecret(secret: string): {
  appId: string;
  appSecret: string;
  domain: string;
  /** Present when the app was created through the QR flow. */
  ownerOpenId: string;
} {
  try {
    const v = JSON.parse(secret);
    if (v.app_id || v.app_secret) {
      return {
        appId: v.app_id ?? '', appSecret: v.app_secret ?? '', domain: v.domain ?? 'feishu',
        ownerOpenId: v.owner_open_id ?? '',
      };
    }
  } catch { /* plain text */ }
  const [appId = '', appSecret = '', domain = 'feishu'] = secret.split(/[\n,]+/).map(s => s.trim());
  return { appId, appSecret, domain, ownerOpenId: '' };
}

async function feishuAuth(secret: string) {
  const { appId, appSecret, domain } = parseFeishuSecret(secret);
  if (!appId || !appSecret) throw new Error('feishu app_id and app_secret are required');
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: timeout(),
  });
  const body = await res.json() as Record<string, any>;
  if (body.code !== 0) throw new Error(`tenant_access_token: ${body.msg ?? body.code}`);
  return { appId, domain, base, token: body.tenant_access_token as string };
}

export interface FeishuChat {
  chatId: string;
  name: string;
  mode: string;
}

/** Groups the bot has been added to. Requires im:chat:readonly. */
export async function listFeishuChats(secret: string): Promise<FeishuChat[]> {
  const { base, token } = await feishuAuth(secret);
  const res = await fetch(`${base}/open-apis/im/v1/chats?page_size=100`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeout(),
  });
  const body = await res.json() as Record<string, any>;
  if (body.code !== 0) throw new Error(`list chats: ${body.msg ?? body.code}`);
  return (body.data?.items ?? []).map((c: Record<string, any>) => ({
    chatId: String(c.chat_id ?? ''),
    name: String(c.name ?? ''),
    mode: String(c.chat_mode ?? ''),
  }));
}

async function testFeishu(secret: string): Promise<string> {
  const { appId, domain, base, token } = await feishuAuth(secret);
  const botRes = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeout(),
  });
  const bot = await botRes.json() as Record<string, any>;
  if (bot.code !== 0) throw new Error(`bot info: ${bot.msg ?? bot.code}`);
  return `app=${appId} bot=${bot.bot?.app_name ?? '?'} domain=${domain}`;
}

export async function sendTestMessage(kind: string, secret: string, target: string, text = 'WardenDeck 测试消息'): Promise<string> {
  if (!target) throw new Error('target chat/channel is required');
  if (kind === 'slack') {
    const { bot } = parseSlackSecret(secret);
    if (!bot) throw new Error('slack bot token (xoxb-) missing');
    const res = await slackCall(bot, 'chat.postMessage', { channel: target, text });
    return `sent ts=${res.ts}`;
  }
  if (kind === 'telegram') {
    const token = secret.trim();
    if (!token || !token.includes(':')) throw new Error('invalid telegram bot token');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text }),
      signal: timeout(),
    });
    const body = await res.json() as Record<string, any>;
    if (!body.ok) throw new Error(`sendMessage: ${body.description ?? 'failed'}`);
    return `sent message_id=${body.result.message_id}`;
  }
  if (kind === 'feishu') {
    const { base, token } = await feishuAuth(secret);
    const idType = target.startsWith('ou_') ? 'open_id' : 'chat_id';
    const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=${idType}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: target, msg_type: 'text', content: JSON.stringify({ text }) }),
      signal: timeout(),
    });
    const body = await res.json() as Record<string, any>;
    if (body.code !== 0) throw new Error(`send message: ${body.msg ?? body.code}`);
    return `sent message_id=${body.data?.message_id ?? '?'}`;
  }
  throw new Error(`unsupported platform ${kind}`);
}
