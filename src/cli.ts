#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { defaultAgent, detectAgents } from './agents.js';
import { runChecks } from './doctor.js';
import { FeishuConnectors } from './feishu.js';
import { feishuBegin, feishuPoll, listFeishuChats, parseFeishuSecret, sendTestMessage, testPlatform } from './platform.js';
import { MEMORY_SCOPES, randomToken, Store, type MemoryScope, type Role } from './store.js';
import { createServer } from './server.js';
import { version } from './version.js';

const defaultDir = () => process.env.WARDENDECK_DIR ?? path.join(os.homedir(), '.wardendeck');
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function usage() {
  console.log(`wardendeck — prototype control plane for local coding agents

Usage: wardendeck <command> [flags]

  init       create config, master key and owner
  serve      start the web console / API
  doctor     check environment and configuration
  agents     list locally detected agent CLIs
  status     show a short summary
  token      reset the one-time setup token
  secret     set|list credentials
  feishu     setup (scan QR) | chats (groups the bot joined)
  platform   test|bind|list|unbind messaging platforms
  assistant  add|list bots (memory owners)
  memory     add|list|forget long-term memory
  project    create|list projects
  model      add|set|list models
  user       add|map|grant|list users
  audit      list|verify audit log

Every command accepts --dir (default ~/.wardendeck or $WARDENDECK_DIR).`);
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`error: Node.js >= 22.13 is required (found ${process.versions.node})`);
    process.exit(1);
  }
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'init': return init(args);
    case 'serve': return serve(args);
    case 'doctor': return doctor(args);
    case 'agents': return agents();
    case 'status': return status(args);
    case 'token': return token(args);
    case 'secret': return secret(args);
    case 'feishu': return feishu(args);
    case 'platform': return platform(args);
    case 'assistant': return assistant(args);
    case 'memory': return memory(args);
    case 'project': return project(args);
    case 'model': return model(args);
    case 'user': return user(args);
    case 'audit': return audit(args);
    case 'version': case '--version': case '-v': console.log(version); return;
    default: usage(); process.exitCode = 2;
  }
}

async function init(args: string[]) {
  const { values } = parseArgs({ args, options: {
    dir: { type: 'string', default: defaultDir() },
    'admin-email': { type: 'string' },
    bind: { type: 'string', default: '127.0.0.1:8787' },
    force: { type: 'boolean', default: false },
    'setup-token': { type: 'string' },
  } });
  const dir = path.resolve(str(values.dir));
  let email = str(values['admin-email']);
  if (!email) email = await ask('Owner email: ');
  if (!email) throw new Error('--admin-email is required');
  const setupToken = str(values['setup-token']);
  if (setupToken && setupToken.length < 12) {
    console.warn('warning: weak setup token; use this only for local testing');
  }
  const { store, token } = Store.init(dir, email, str(values.bind, '127.0.0.1:8787'), !!values.force, setupToken);
  console.log(`initialized ${store.dir}`);
  console.log(`setup token (shown once): ${token}`);
  console.log(`next: wardendeck serve --dir ${store.dir}`);
}

async function serve(args: string[]) {
  const { values } = parseArgs({ args, options: {
    dir: { type: 'string', default: defaultDir() },
    'no-web': { type: 'boolean', default: false },
  } });
  const store = Store.open(path.resolve(str(values.dir)));
  const connectors = new FeishuConnectors(store);
  await connectors.start();
  const server = createServer(store, !!values['no-web'], () => connectors.restart());
  const [host, port] = splitBind(store.bind);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`WardenDeck ${version} listening on http://${store.bind}`);
  if (values['no-web']) console.log('web console disabled (--no-web); API is still available');
  const stop = () => {
    connectors.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function doctor(args: string[]) {
  const { values } = parseArgs({ args, options: { dir: { type: 'string', default: defaultDir() } } });
  const store = Store.open(path.resolve(str(values.dir)));
  let failed = 0;
  for (const c of await runChecks(store)) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name.padEnd(16)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`      fix: ${c.fix}`);
  }
  if (failed) process.exitCode = 3;
}

async function agents() {
  const list = detectAgents();
  if (!list.length) {
    console.log('no agent CLI found (install Claude Code or Codex)');
    return;
  }
  for (const a of list) console.log(`${a.name.padEnd(12)} ${a.version.padEnd(24)} ${a.path}`);
}

async function status(args: string[]) {
  const { values } = parseArgs({ args, options: { dir: { type: 'string', default: defaultDir() } } });
  const store = Store.open(path.resolve(str(values.dir)));
  const s = store.snapshot();
  console.log(`WardenDeck ${version}  ${store.bind}`);
  console.log(`assistants=${s.counts.assistants} projects=${s.counts.projects} models=${s.counts.models} users=${s.counts.users} bindings=${s.counts.bindings} memories=${s.counts.memories} audit=${s.counts.audit}`);
  for (const a of s.assistants) {
    console.log(`  assistant ${a.name.padEnd(12)} agent=${a.default_agent}`);
  }
  for (const p of s.projects) {
    console.log(`  project ${p.name.padEnd(12)} agent=${p.agent.padEnd(10)} perm=${(p.permission_mode || 'default').padEnd(18)} model=${(p.default_model || '-').padEnd(22)} ${p.workdir}`);
  }
}

async function token(args: string[]) {
  if (args[0] !== 'reset') throw new Error('usage: wardendeck token reset --dir <dir>');
  const { values } = parseArgs({ args: args.slice(1), options: {
    dir: { type: 'string', default: defaultDir() },
    set: { type: 'string' },
  } });
  const store = Store.open(path.resolve(str(values.dir)));
  const set = str(values.set);
  if (set && set.length < 12) {
    console.warn('warning: weak setup token; use this only for local testing');
  }
  console.log('new setup token (shown once):', store.resetToken(set));
}

async function secret(args: string[]) {
  const sub = args[0];
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: { dir: { type: 'string', default: defaultDir() } } });
    for (const ref of Store.open(path.resolve(str(values.dir))).secrets()) console.log(ref);
    return;
  }
  if (sub !== 'set' || !args[1]) throw new Error('usage: wardendeck secret set <ref> [--value v]');
  const ref = args[1];
  const { values } = parseArgs({ args: args.slice(2), options: {
    dir: { type: 'string', default: defaultDir() },
    value: { type: 'string' },
  } });
  const value = str(values.value) || await ask('Secret value: ');
  if (!value) throw new Error('empty secret');
  Store.open(path.resolve(str(values.dir))).setSecret(ref, value);
  console.log('stored', ref);
}

async function feishu(args: string[]) {
  if (args[0] === 'chats') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      credential: { type: 'string', default: 'feishu_main' },
    } });
    const store = Store.open(path.resolve(str(values.dir)));
    const credential = str(values.credential, 'feishu_main');
    const raw = store.getSecret(credential);
    if (!raw) throw new Error(`credential ${credential} not found`);
    const chats = await listFeishuChats(raw);
    if (!chats.length) {
      console.log('机器人还没有加入任何群。先把机器人拉进群，再运行一次。');
      return;
    }
    for (const c of chats) console.log(`${c.chatId}\t${c.mode}\t${c.name}`);
    console.log('\n绑定群聊：wardendeck platform bind --project <name> --platform feishu ' +
      `--credential ${credential} --channel ${chats[0].chatId} --allowed-users <open_id>`);
    return;
  }
  if (args[0] !== 'setup') throw new Error('usage: wardendeck feishu setup|chats [--project name] [--credential ref]');
  const { values } = parseArgs({ args: args.slice(1), options: {
    dir: { type: 'string', default: defaultDir() },
    project: { type: 'string' }, credential: { type: 'string' },
  } });
  const store = Store.open(path.resolve(str(values.dir)));
  const project = str(values.project, 'main');
  const credential = str(values.credential, `feishu_${project}`);

  const begin = await feishuBegin();
  console.log('请在手机飞书/Lark 中打开下面的链接完成授权（会自动创建应用）：');
  console.log(begin.qrUrl);
  console.log(`链接 ${begin.expiresIn} 秒内有效，等待授权…`);

  let interval = begin.interval;
  let baseUrl = begin.baseUrl;
  const deadline = Date.now() + begin.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval * 1000));
    let poll;
    try {
      poll = await feishuPoll(begin.deviceCode, baseUrl);
    } catch (err) {
      // Network hiccups must not abort the whole authorization flow.
      console.error('查询授权状态失败，继续重试：', err instanceof Error ? err.message : err);
      continue;
    }
    baseUrl = poll.baseUrl;
    if (poll.slowDown) interval += 2;
    if (poll.status === 'pending') continue;
    if (poll.status !== 'completed') {
      throw new Error(`feishu setup ${poll.status}${poll.error ? ': ' + poll.error : ''}`);
    }
    store.setSecret(credential, JSON.stringify({
      app_id: poll.appId, app_secret: poll.appSecret,
      domain: poll.platform, owner_open_id: poll.ownerOpenId,
    }));
    console.log('应用创建成功');
    console.log('app_id:', poll.appId);
    if (poll.ownerOpenId) console.log('owner_open_id:', poll.ownerOpenId);
    console.log('credential:', credential);

    // The owner's open_id is also the private-chat fallback channel, so the
    // freshly created bot can be usable immediately without a second command.
    if (poll.ownerOpenId && store.projectExists(project)) {
      const bound = store.channelBound(poll.ownerOpenId);
      if (bound) {
        console.log(`私聊已有绑定（${bound}），跳过自动绑定`);
      } else {
        const id = randomToken(6);
        store.addBinding({
          id, assistant_id: 'default', project, platform: 'feishu', credential,
          channels: [poll.ownerOpenId], allowed_users: [poll.ownerOpenId], mention_only: true,
        });
        console.log(`已自动绑定私聊 ${poll.ownerOpenId} -> default/${project}（binding ${id}）`);
      }
    } else if (!store.projectExists(project)) {
      console.log(`项目 ${project} 不存在，未自动绑定；创建项目后执行 platform bind`);
    }
    console.log('next: wardendeck serve');
    return;
  }
  throw new Error('feishu setup expired, please retry');
}

async function platform(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'test') {
    const { values } = parseArgs({ args: rest, options: {
      dir: { type: 'string', default: defaultDir() },
      platform: { type: 'string' }, credential: { type: 'string' },
      'app-token': { type: 'string' }, 'bot-token': { type: 'string' }, token: { type: 'string' },
      'app-id': { type: 'string' }, 'app-secret': { type: 'string' }, domain: { type: 'string' },
      'send-to': { type: 'string' }, text: { type: 'string' },
    } });
    const store = Store.open(path.resolve(str(values.dir)));
    let secretValue = str(values.token);
    if (values.credential) secretValue = store.getSecret(str(values.credential)) ?? '';
    if (values.platform === 'slack' && (values['app-token'] || values['bot-token'])) {
      secretValue = `${str(values['app-token'])}\n${str(values['bot-token'])}`;
    }
    if (values.platform === 'feishu' && (values['app-id'] || values['app-secret'])) {
      secretValue = JSON.stringify({
        app_id: str(values['app-id']), app_secret: str(values['app-secret']),
        domain: str(values.domain, 'feishu'),
      });
    }
    if (values['send-to']) {
      console.log('SENT:', await sendTestMessage(str(values.platform), secretValue,
        str(values['send-to']), str(values.text, 'WardenDeck 测试消息')));
    } else {
      console.log('OK:', await testPlatform(str(values.platform), secretValue));
    }
    return;
  }
  if (sub === 'bind') {
    const { values } = parseArgs({ args: rest, options: {
      dir: { type: 'string', default: defaultDir() },
      assistant: { type: 'string', default: 'default' },
      project: { type: 'string' }, platform: { type: 'string' },
      credential: { type: 'string' }, channel: { type: 'string' },
      'allowed-users': { type: 'string' },
      'mention-only': { type: 'boolean', default: true },
    }, allowNegative: true });
    if (!values.project || !values.platform || !values.channel) {
      throw new Error('--project, --platform and --channel are required');
    }
    const platform = str(values.platform);
    if (!['slack', 'telegram', 'feishu'].includes(platform)) {
      throw new Error('--platform must be one of slack, telegram, feishu');
    }
    const credential = str(values.credential);
    const store = Store.open(path.resolve(str(values.dir)));
    let allow = str(values['allowed-users']).split(/[\s,]+/).filter(Boolean);
    if (!allow.length) {
      // QR-created Feishu apps record the person who authorized them. Default
      // to that owner instead of denying everyone; if we cannot prove who the
      // owner is, stay fail-closed.
      const raw = credential ? store.getSecret(credential) : undefined;
      const owner = raw && platform === 'feishu' ? parseFeishuSecret(raw).ownerOpenId : '';
      if (!owner) throw new Error('--allowed-users is required (no app owner recorded for this credential)');
      allow = [owner];
      console.log(`未指定 --allowed-users，默认仅允许应用创建者 ${owner}`);
    }
    if (!store.assistantExists(str(values.assistant, 'default'))) {
      throw new Error(`assistant ${values.assistant} not found`);
    }
    if (!store.projectExists(str(values.project))) throw new Error(`project ${values.project} not found`);
    const bound = store.channelBound(str(values.channel));
    if (bound) throw new Error(`channel ${values.channel} already bound to ${bound}`);
    if (!store.getSecret(credential)) throw new Error(`credential ${credential} not found`);
    const id = randomToken(6);
    store.addBinding({
      id, assistant_id: str(values.assistant, 'default'),
      project: str(values.project), platform: str(values.platform), credential,
      channels: [str(values.channel)], allowed_users: allow,
      mention_only: values['mention-only'] !== false,
    });
    console.log(`bound ${values.platform} ${values.channel} -> ${values.assistant}/${values.project} (binding ${id})`);
    return;
  }
  if (sub === 'list') {
    const { values } = parseArgs({ args: rest, options: { dir: { type: 'string', default: defaultDir() } } });
    for (const b of Store.open(path.resolve(str(values.dir))).snapshot().bindings) {
      console.log(`${b.id.padEnd(8)} ${b.platform.padEnd(8)} ${(b.assistant_id || 'default').padEnd(12)} ${b.project.padEnd(12)} channels=${b.channels.join(',')} allowed=${b.allowed_users.join(',')}`);
    }
    return;
  }
  if (sub === 'unbind') {
    const { values } = parseArgs({ args: rest, options: {
      dir: { type: 'string', default: defaultDir() }, id: { type: 'string' },
    } });
    Store.open(path.resolve(str(values.dir))).deleteBinding(str(values.id));
    return;
  }
  throw new Error('usage: wardendeck platform test|bind|list|unbind');
}

async function assistant(args: string[]) {
  const sub = args[0];
  if (sub === 'add') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      name: { type: 'string' }, agent: { type: 'string', default: 'claudecode' },
    } });
    if (!values.name) throw new Error('--name is required');
    const store = Store.open(path.resolve(str(values.dir)));
    const a = store.addAssistant(str(values.name), str(values.agent, 'claudecode'));
    console.log(`assistant ${a.name} created (agent=${a.default_agent})`);
    return;
  }
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: { dir: { type: 'string', default: defaultDir() } } });
    const store = Store.open(path.resolve(str(values.dir)));
    for (const a of store.assistants()) {
      const count = store.memories(a.id).length;
      console.log(`${a.name.padEnd(16)} agent=${a.default_agent.padEnd(12)} memories=${count}`);
    }
    return;
  }
  throw new Error('usage: wardendeck assistant add|list');
}

async function memory(args: string[]) {
  const sub = args[0];
  if (sub === 'add') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      assistant: { type: 'string', default: 'default' },
      scope: { type: 'string', default: 'assistant' },
      'scope-id': { type: 'string' },
      kind: { type: 'string', default: 'fact' },
      text: { type: 'string' }, source: { type: 'string' },
      confidence: { type: 'string', default: '1' },
    } });
    const scope = str(values.scope, 'assistant') as MemoryScope;
    if (!MEMORY_SCOPES.includes(scope)) throw new Error(`scope must be one of ${MEMORY_SCOPES.join(', ')}`);
    if (!str(values.text)) throw new Error('--text is required');
    const store = Store.open(path.resolve(str(values.dir)));
    const item = store.addMemory({
      assistant_id: str(values.assistant, 'default'), scope_type: scope,
      scope_id: str(values['scope-id']), kind: str(values.kind, 'fact'),
      content: str(values.text), source: str(values.source), confidence: num(values.confidence, 1),
    });
    console.log(`memory #${item.id} added (${item.scope_type}${item.scope_id ? ':' + item.scope_id : ''})`);
    return;
  }
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      assistant: { type: 'string', default: 'default' },
    } });
    const store = Store.open(path.resolve(str(values.dir)));
    for (const m of store.memories(str(values.assistant, 'default'))) {
      console.log(`#${String(m.id).padEnd(4)} ${(m.scope_type + (m.scope_id ? ':' + m.scope_id : '')).padEnd(28)} ${m.kind.padEnd(10)} ${m.content.slice(0, 120)}`);
    }
    return;
  }
  if (sub === 'forget') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      assistant: { type: 'string', default: 'default' },
      id: { type: 'string' },
    } });
    const id = Number(values.id);
    if (!Number.isInteger(id)) throw new Error('--id is required');
    Store.open(path.resolve(str(values.dir))).forgetMemory(str(values.assistant, 'default'), id);
    console.log(`memory #${id} forgotten`);
    return;
  }
  throw new Error('usage: wardendeck memory add|list|forget');
}

async function project(args: string[]) {
  const sub = args[0];
  if (sub === 'create') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      name: { type: 'string' }, workdir: { type: 'string' }, agent: { type: 'string' },
      'permission-mode': { type: 'string', default: 'default' },
    } });
    const workdir = path.resolve(str(values.workdir).replace(/^~(?=\/)/, os.homedir()));
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
      throw new Error(`workdir does not exist: ${values.workdir}`);
    }
    const mode = str(values['permission-mode'], 'default');
    if (!['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(mode)) {
      throw new Error('--permission-mode must be one of default, acceptEdits, bypassPermissions, plan, dontAsk, auto');
    }
    const store = Store.open(path.resolve(str(values.dir)));
    if (store.projectExists(str(values.name))) throw new Error(`project ${values.name} already exists`);
    store.addProject(str(values.name), workdir, str(values.agent) || defaultAgent(), mode);
    return;
  }
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: { dir: { type: 'string', default: defaultDir() } } });
    for (const p of Store.open(path.resolve(str(values.dir))).snapshot().projects) {
      console.log(`${p.name.padEnd(12)} ${p.agent.padEnd(10)} ${(p.default_model || '-').padEnd(22)} ${p.workdir}`);
    }
    return;
  }
  if (sub === 'permission') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      name: { type: 'string' }, mode: { type: 'string' },
    } });
    const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
    if (!modes.includes(str(values.mode))) throw new Error(`mode must be one of ${modes.join(', ')}`);
    Store.open(path.resolve(str(values.dir))).setProjectPermissionMode(str(values.name), str(values.mode));
    return;
  }
  throw new Error('usage: wardendeck project create|list|permission');
}

async function model(args: string[]) {
  const sub = args[0];
  if (sub === 'add') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      id: { type: 'string' }, 'display-name': { type: 'string' }, provider: { type: 'string', default: 'custom' },
    } });
    if (!values.id) throw new Error('--id is required');
    const store = Store.open(path.resolve(str(values.dir)));
    if (store.snapshot().models.some(m => m.id === values.id)) throw new Error(`model ${values.id} already exists`);
    store.addModel(str(values.id), str(values['display-name'], str(values.id)), str(values.provider, 'custom'));
    return;
  }
  if (sub === 'set') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      project: { type: 'string' }, default: { type: 'string' },
    } });
    const store = Store.open(path.resolve(str(values.dir)));
    if (!store.modelExists(str(values.default))) throw new Error(`model ${values.default} not found`);
    store.setDefaultModel(str(values.project), str(values.default));
    return;
  }
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: { dir: { type: 'string', default: defaultDir() } } });
    for (const m of Store.open(path.resolve(str(values.dir))).snapshot().models) {
      console.log(`${m.id.padEnd(24)} ${m.display_name.padEnd(20)} ${m.provider}`);
    }
    return;
  }
  throw new Error('usage: wardendeck model add|set|list');
}

async function user(args: string[]) {
  const sub = args[0];
  if (sub === 'add') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      email: { type: 'string' }, role: { type: 'string', default: 'viewer' },
    } });
    if (!values.email) throw new Error('--email is required');
    const role = str(values.role, 'viewer') as Role;
    if (!['owner', 'admin', 'operator', 'viewer'].includes(role)) throw new Error(`invalid role ${role}`);
    const store = Store.open(path.resolve(str(values.dir)));
    if (store.userExists(str(values.email))) throw new Error(`user ${values.email} already exists`);
    store.addUser(str(values.email), role);
    return;
  }
  if (sub === 'map') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      platform: { type: 'string' }, 'external-id': { type: 'string' }, email: { type: 'string' },
    } });
    const store = Store.open(path.resolve(str(values.dir)));
    if (!store.userExists(str(values.email))) throw new Error(`user ${values.email} not found`);
    store.mapIdentity(str(values.platform), str(values['external-id']), str(values.email));
    return;
  }
  if (sub === 'grant') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() },
      project: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', default: 'operator' },
    } });
    const store = Store.open(path.resolve(str(values.dir)));
    if (!store.projectExists(str(values.project)) || !store.userExists(str(values.email))) {
      throw new Error('project or user not found');
    }
    const role = str(values.role, 'operator') as Role;
    if (!['owner', 'admin', 'operator', 'viewer'].includes(role)) throw new Error(`invalid role ${role}`);
    store.grant(str(values.project), str(values.email), role);
    return;
  }
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: { dir: { type: 'string', default: defaultDir() } } });
    for (const u of Store.open(path.resolve(str(values.dir))).snapshot().users) {
      console.log(`${u.email.padEnd(30)} ${u.role}`);
    }
    return;
  }
  throw new Error('usage: wardendeck user add|map|grant|list');
}

async function audit(args: string[]) {
  const sub = args[0];
  if (sub === 'list') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      dir: { type: 'string', default: defaultDir() }, limit: { type: 'string', default: '30' },
    } });
    for (const e of Store.open(path.resolve(str(values.dir))).auditEvents(num(values.limit, 30))) {
      console.log(`${String(e.seq).padStart(4)}  ${e.ts.slice(11, 19)}  ${e.action.padEnd(18)} ${e.target.padEnd(26)} ${e.result}`);
    }
    return;
  }
  if (sub === 'verify') {
    const { values } = parseArgs({ args: args.slice(1), options: { dir: { type: 'string', default: defaultDir() } } });
    const result = Store.open(path.resolve(str(values.dir))).verifyAudit();
    if (!result.ok) throw new Error(`audit chain broken at seq ${result.brokenAt}`);
    console.log('audit chain OK');
    return;
  }
  throw new Error('usage: wardendeck audit list|verify');
}

function splitBind(bind: string): [string, number] {
  const i = bind.lastIndexOf(':');
  return i > 0 ? [bind.slice(0, i), Number(bind.slice(i + 1))] : ['127.0.0.1', Number(bind)];
}

main().catch(err => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
