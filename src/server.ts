import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { defaultAgent, detectAgents } from './agents.js';
import { rootDir, runChecks } from './doctor.js';
import { feishuBegin, feishuPoll, parseFeishuSecret, sendTestMessage, testPlatform } from './platform.js';
import { MEMORY_SCOPES, randomToken, type MemoryScope, type Role, type Store } from './store.js';
import { version } from './version.js';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
type Json = Record<string, any>;

const ROLES: Role[] = ['owner', 'admin', 'operator', 'viewer'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];

const json = (res: Res, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const fail = (res: Res, status: number, error: string) => json(res, status, { error });

async function body(req: Req): Promise<Json> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function cookie(req: Req, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function createServer(store: Store, noWeb: boolean, onChange?: () => void): http.Server {
  const sessions = new Map<string, number>();
  const started = Date.now();
  const webIndex = noWeb ? null : fs.readFileSync(path.join(rootDir, 'web', 'index.html'));

  const authed = (req: Req) => {
    const token = cookie(req, 'aw_session');
    const exp = token ? sessions.get(token) : undefined;
    if (!exp || Date.now() > exp) {
      if (token) sessions.delete(token);
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method ?? 'GET';

    try {
      if (p === '/api/v1/login' && m === 'POST') return login(req, res);
      if (p === '/api/v1/logout' && m === 'POST') {
        const t = cookie(req, 'aw_session');
        if (t) sessions.delete(t);
        res.setHeader('Set-Cookie', 'aw_session=; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (p.startsWith('/api/v1/') && !authed(req)) return fail(res, 401, 'unauthorized');
      if (p === '/api/v1/state' && m === 'GET') {
        return json(res, 200, {
          version,
          uptime: Math.floor((Date.now() - started) / 1000),
          config: { bind: store.bind, admin_email: store.adminEmail },
          state: store.snapshot(),
        });
      }
      if (p === '/api/v1/doctor' && m === 'GET') {
        return json(res, 200, { version, checks: await runChecks(store) });
      }
      if (p === '/api/v1/agents' && m === 'GET') {
        return json(res, 200, { agents: detectAgents(), default: defaultAgent() });
      }
      if (p === '/api/v1/audit' && m === 'GET') {
        const checked = store.verifyAudit();
        return json(res, 200, {
          ok: checked.ok,
          broken_at: checked.brokenAt,
          events: store.auditEvents(200),
        });
      }
      if (p === '/api/v1/assistants' && m === 'GET') {
        return json(res, 200, { assistants: store.assistants() });
      }
      if (p === '/api/v1/assistants' && m === 'POST') return addAssistant(req, res);
      if (p === '/api/v1/memories' && m === 'GET') return listMemories(res, url);
      if (p === '/api/v1/memories' && m === 'POST') return addMemory(req, res);
      if (p === '/api/v1/memories/forget' && m === 'POST') return forgetMemory(req, res);
      if (p === '/api/v1/projects' && m === 'POST') return addProject(req, res);
      if (p === '/api/v1/projects/permission' && m === 'POST') return setProjectPermission(req, res);
      if (p === '/api/v1/models' && m === 'POST') return addModel(req, res);
      if (p === '/api/v1/models/default' && m === 'POST') return setDefault(req, res);
      if (p === '/api/v1/users' && m === 'POST') return addUser(req, res);
      if (p === '/api/v1/users/map' && m === 'POST') return mapUser(req, res);
      if (p === '/api/v1/users/role' && m === 'POST') return setRole(req, res);
      if (p === '/api/v1/grants' && m === 'POST') return grant(req, res);
      if (p === '/api/v1/bindings' && m === 'POST') return addBinding(req, res);
      if (p === '/api/v1/bindings/delete' && m === 'POST') return removeBinding(req, res);
      if (p === '/api/v1/bindings/test' && m === 'POST') return testBinding(req, res);
      if (p === '/api/v1/setup/feishu/begin' && m === 'POST') return feishuSetupBegin(req, res);
      if (p === '/api/v1/setup/feishu/poll' && m === 'POST') return feishuSetupPoll(req, res);
      if (p === '/api/v1/mock/message' && m === 'POST') return mockMessage(req, res);
      if (!p.startsWith('/api/') && webIndex && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(webIndex);
      }
      return fail(res, 404, 'not found');
    } catch (e) {
      return fail(res, 400, e instanceof Error ? e.message : String(e));
    }
  });

  async function login(req: Req, res: Res) {
    const { token } = await body(req);
    if (typeof token !== 'string' || !store.tokenValid(token)) return fail(res, 401, 'invalid setup token');
    const session = randomToken(24);
    sessions.set(session, Date.now() + 12 * 3600_000);
    res.setHeader('Set-Cookie',
      `aw_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
    store.audit('owner', 'auth.login', 'web', 'ok');
    return json(res, 200, { ok: true, version });
  }

  async function addAssistant(req: Req, res: Res) {
    const b = await body(req);
    if (!b.name) return fail(res, 400, 'name is required');
    const agent = b.default_agent || 'claudecode';
    if (!['claudecode', 'codex'].includes(agent)) return fail(res, 400, 'invalid agent');
    if (store.assistantExists(b.name)) return fail(res, 409, `assistant ${b.name} already exists`);
    const assistant = store.addAssistant(b.name, agent);
    return json(res, 200, { ok: true, assistant });
  }

  function listMemories(res: Res, url: URL) {
    const assistant = url.searchParams.get('assistant') || 'default';
    if (!store.assistantExists(assistant)) return fail(res, 404, `assistant ${assistant} not found`);
    return json(res, 200, { assistant, items: store.memories(assistant) });
  }

  async function addMemory(req: Req, res: Res) {
    const b = await body(req);
    const assistant = String(b.assistant || 'default');
    if (!store.assistantExists(assistant)) return fail(res, 404, `assistant ${assistant} not found`);
    const scope = String(b.scope_type || 'assistant') as MemoryScope;
    if (!MEMORY_SCOPES.includes(scope)) return fail(res, 400, 'invalid scope');
    if (!b.content || !String(b.content).trim()) return fail(res, 400, 'content is required');
    try {
      const item = store.addMemory({
        assistant_id: assistant, scope_type: scope, scope_id: b.scope_id,
        kind: b.kind || 'fact', content: String(b.content),
        source: b.source || 'console', confidence: Number(b.confidence ?? 1),
      });
      return json(res, 200, { ok: true, item });
    } catch (e) {
      return fail(res, 400, e instanceof Error ? e.message : String(e));
    }
  }

  async function forgetMemory(req: Req, res: Res) {
    const b = await body(req);
    const assistant = String(b.assistant || 'default');
    const id = Number(b.id);
    if (!Number.isInteger(id)) return fail(res, 400, 'id is required');
    try {
      store.forgetMemory(assistant, id);
      return json(res, 200, { ok: true });
    } catch (e) {
      return fail(res, 404, e instanceof Error ? e.message : String(e));
    }
  }

  async function addProject(req: Req, res: Res) {
    const b = await body(req);
    if (!b.name || !b.workdir) return fail(res, 400, 'name and workdir are required');
    const agent = b.agent || defaultAgent();
    if (!['claudecode', 'codex'].includes(agent)) return fail(res, 400, 'invalid agent');
    const mode = b.permission_mode || 'default';
    if (!PERMISSION_MODES.includes(mode)) return fail(res, 400, 'invalid permission mode');
    const workdir = path.resolve(String(b.workdir).replace(/^~(?=\/)/, process.env.HOME ?? '~'));
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
      return fail(res, 400, `workdir does not exist: ${b.workdir}`);
    }
    if (store.projectExists(b.name)) return fail(res, 409, `project ${b.name} already exists`);
    store.addProject(b.name, workdir, agent, mode);
    return json(res, 200, { ok: true });
  }

  async function setProjectPermission(req: Req, res: Res) {
    const b = await body(req);
    if (!store.projectExists(b.project)) return fail(res, 400, `project ${b.project} not found`);
    if (!PERMISSION_MODES.includes(b.mode)) return fail(res, 400, 'invalid permission mode');
    store.setProjectPermissionMode(b.project, b.mode);
    return json(res, 200, { ok: true });
  }

  async function addModel(req: Req, res: Res) {
    const b = await body(req);
    if (!b.id) return fail(res, 400, 'model id is required');
    if (store.snapshot().models.some(x => x.id === b.id)) return fail(res, 409, `model ${b.id} already exists`);
    store.addModel(b.id, b.display_name || b.id, b.provider || 'custom');
    return json(res, 200, { ok: true });
  }

  async function setDefault(req: Req, res: Res) {
    const b = await body(req);
    if (!store.modelExists(b.model)) return fail(res, 400, `model ${b.model} not found`);
    store.setDefaultModel(b.project, b.model);
    return json(res, 200, { ok: true });
  }

  async function addUser(req: Req, res: Res) {
    const b = await body(req);
    const role = (b.role || 'viewer') as Role;
    if (!b.email) return fail(res, 400, 'email is required');
    if (!ROLES.includes(role)) return fail(res, 400, 'invalid role');
    if (store.userExists(b.email)) return fail(res, 409, `user ${b.email} already exists`);
    store.addUser(b.email, role);
    return json(res, 200, { ok: true });
  }

  async function mapUser(req: Req, res: Res) {
    const b = await body(req);
    if (!['slack', 'telegram', 'feishu'].includes(b.platform)) return fail(res, 400, 'unsupported platform');
    if (!b.external_id || !store.userExists(b.email)) return fail(res, 400, 'user or external_id missing');
    store.mapIdentity(b.platform, String(b.external_id), b.email);
    return json(res, 200, { ok: true });
  }

  async function setRole(req: Req, res: Res) {
    const b = await body(req);
    if (!ROLES.includes(b.role)) return fail(res, 400, 'invalid role');
    store.setUserRole(b.email, b.role);
    return json(res, 200, { ok: true });
  }

  async function grant(req: Req, res: Res) {
    const b = await body(req);
    if (!store.projectExists(b.project) || !store.userExists(b.email)) {
      return fail(res, 400, 'project or user not found');
    }
    if (!ROLES.includes(b.role)) return fail(res, 400, 'invalid role');
    store.grant(b.project, b.email, b.role);
    return json(res, 200, { ok: true });
  }

  async function addBinding(req: Req, res: Res) {
    const b = await body(req);
    if (!b.project || !b.platform || !b.channel) {
      return fail(res, 400, 'project, platform and channel/chat are required');
    }
    if (!['slack', 'telegram', 'feishu'].includes(b.platform)) return fail(res, 400, 'unsupported platform');
    let allow = String(b.allowed_users ?? '').split(/[\s,]+/).filter(Boolean);
    const assistant = String(b.assistant || 'default');
    if (!store.assistantExists(assistant)) return fail(res, 400, `assistant ${assistant} not found`);
    if (!store.projectExists(b.project)) return fail(res, 400, `project ${b.project} not found`);
    const owner = store.channelBound(b.channel);
    if (owner) return fail(res, 409, `channel ${b.channel} already bound to ${owner}`);

    let credential = b.credential || `${b.platform}_${b.project}`;
    if (b.platform === 'slack' && (b.app_token || b.bot_token)) {
      if (!b.bot_token) return fail(res, 400, 'slack bot token is required');
      store.setSecret(credential, `${b.app_token ?? ''}\n${b.bot_token}`);
    } else if (b.platform === 'telegram' && b.token) {
      store.setSecret(credential, b.token);
    } else if (b.platform === 'feishu' && (b.app_id || b.app_secret)) {
      if (!b.app_id || !b.app_secret) return fail(res, 400, 'feishu app_id and app_secret are required');
      store.setSecret(credential, JSON.stringify({
        app_id: b.app_id, app_secret: b.app_secret, domain: b.domain || 'feishu',
      }));
    }
    const raw = store.getSecret(credential);
    if (!raw) return fail(res, 400, `credential not found: ${credential}`);
    if (allow.length === 0) {
      // Same policy as the CLI: a QR-created app may default to its owner,
      // otherwise an empty allowlist is rejected rather than opened up.
      const ownerOpenId = b.platform === 'feishu' ? parseFeishuSecret(raw).ownerOpenId : '';
      if (!ownerOpenId) return fail(res, 400, 'allowed_users is required (no app owner recorded for this credential)');
      allow = [ownerOpenId];
    }

    store.addBinding({
      id: randomToken(6), assistant_id: assistant,
      project: b.project, platform: b.platform,
      credential, channels: [b.channel], allowed_users: allow,
      mention_only: b.mention_only !== false,
    });
    onChange?.();
    return json(res, 200, { ok: true });
  }

  async function removeBinding(req: Req, res: Res) {
    const b = await body(req);
    store.deleteBinding(b.id);
    onChange?.();
    return json(res, 200, { ok: true });
  }

  async function testBinding(req: Req, res: Res) {
    const b = await body(req);
    if (!b.platform) return fail(res, 400, 'platform is required');
    let secret = b.token ?? '';
    if (b.credential) {
      secret = store.getSecret(b.credential) ?? '';
      if (!secret) return fail(res, 400, 'credential not found');
    }
    if (b.platform === 'slack' && (b.app_token || b.bot_token)) {
      secret = `${b.app_token ?? ''}\n${b.bot_token ?? ''}`;
    }
    if (b.platform === 'feishu' && (b.app_id || b.app_secret)) {
      secret = JSON.stringify({ app_id: b.app_id, app_secret: b.app_secret, domain: b.domain || 'feishu' });
    }
    try {
      if (b.send) {
        if (!b.channel) return fail(res, 400, 'channel is required to send a test message');
        const detail = await sendTestMessage(b.platform, secret, b.channel, b.text);
        return json(res, 200, { ok: true, detail, sent: true });
      }
      return json(res, 200, { ok: true, detail: await testPlatform(b.platform, secret) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function feishuSetupBegin(req: Req, res: Res) {
    const begin = await feishuBegin();
    store.audit('owner', 'setup.feishu.begin', 'feishu', 'ok');
    return json(res, 200, {
      device_code: begin.deviceCode, qr_url: begin.qrUrl, base_url: begin.baseUrl,
      interval: begin.interval, expires_in: begin.expiresIn,
    });
  }

  async function feishuSetupPoll(req: Req, res: Res) {
    const b = await body(req);
    if (!b.device_code) return fail(res, 400, 'device_code is required');
    const poll = await feishuPoll(b.device_code, b.base_url);
    if (poll.status !== 'completed') {
      return json(res, 200, { status: poll.status, base_url: poll.baseUrl, error: poll.error });
    }
    const credential = b.credential || 'feishu_main';
    store.setSecret(credential, JSON.stringify({
      app_id: poll.appId, app_secret: poll.appSecret,
      domain: poll.platform, owner_open_id: poll.ownerOpenId,
    }));
    store.audit('owner', 'setup.feishu.complete', credential, poll.appId ?? '');
    onChange?.();
    return json(res, 200, {
      status: 'completed', credential, app_id: poll.appId,
      platform: poll.platform, owner_open_id: poll.ownerOpenId,
    });
  }

  async function mockMessage(req: Req, res: Res) {
    const b = await body(req);
    if (!b.text) return fail(res, 400, 'text is required');
    store.audit(b.user || 'unknown', 'message.inbound', b.project || '', b.text);
    return json(res, 200, {
      reply: `[prototype] 已收到：${b.text}`,
      project: b.project,
      note: '真实 agent 执行尚未接入',
    });
  }

  return server;
}
