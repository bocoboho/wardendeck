import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from './store.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));

test('init, snapshot and audit chain', () => {
  const dir = temp();
  const { store, token } = Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  assert.ok(store.tokenValid(token));
  store.addProject('demo', dir, 'claudecode');
  store.addModel('model-a', 'Model A', 'anthropic');
  store.setDefaultModel('demo', 'model-a');
  assert.equal(store.snapshot().projects[0].default_model, 'model-a');
  assert.equal(store.verifyAudit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('memory is isolated per assistant and merged by scope', () => {
  const dir = temp();
  const { store } = Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  store.addProject('demo', dir, 'claudecode');
  store.addAssistant('bot-a');
  store.addAssistant('bot-b');

  store.addMemory({ assistant_id: 'bot-a', scope_type: 'assistant', content: '团队使用 pnpm' });
  store.addMemory({ assistant_id: 'bot-a', scope_type: 'user', scope_id: 'u1', content: '偏好中文' });
  store.addMemory({ assistant_id: 'bot-b', scope_type: 'chat', scope_id: 'c1', content: 'bot-b 的私有信息' });

  assert.equal(store.memories('bot-a').length, 2);
  assert.equal(store.memories('bot-b').length, 1);

  const scopes = [
    { type: 'assistant' as const, id: '' },
    { type: 'project' as const, id: 'demo' },
    { type: 'chat' as const, id: 'c1' },
    { type: 'user' as const, id: 'u1' },
  ];
  const prompt = store.memoryPrompt('bot-a', scopes);
  assert.match(prompt, /pnpm/);
  assert.match(prompt, /偏好中文/);
  assert.doesNotMatch(prompt, /bot-b 的私有信息/);

  const items = store.memoriesFor('bot-a', scopes);
  assert.equal(items[items.length - 1].scope_type, 'user'); // specific scope comes last

  store.forgetMemory('bot-a', items[0].id);
  assert.equal(store.memories('bot-a').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('memory writes are idempotent within a scope', () => {
  const dir = temp();
  const { store } = Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  store.addAssistant('bot-a');
  const first = store.addMemory({ assistant_id: 'bot-a', scope_type: 'assistant', content: '同一条事实' });
  const second = store.addMemory({ assistant_id: 'bot-a', scope_type: 'assistant', content: '同一条事实' });
  assert.equal(first.id, second.id);
  assert.equal(store.memories('bot-a').length, 1);
  // The same text in a different scope is a different memory.
  store.addMemory({ assistant_id: 'bot-a', scope_type: 'user', scope_id: 'u1', content: '同一条事实' });
  assert.equal(store.memories('bot-a').length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('memory prompt ranks relevant items and protects specific scopes', () => {
  const dir = temp();
  const { store } = Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  store.addAssistant('bot-a');
  store.addMemory({ assistant_id: 'bot-a', scope_type: 'assistant', content: '部署命令是 make release' });
  for (let i = 0; i < 40; i++) {
    store.addMemory({
      assistant_id: 'bot-a', scope_type: 'assistant',
      content: `无关事实 ${i} ` + 'x'.repeat(200),
    });
  }
  store.addMemory({
    assistant_id: 'bot-a', scope_type: 'user', scope_id: 'u1',
    content: '用户偏好中文回复',
  });

  const scopes = [
    { type: 'assistant' as const, id: '' },
    { type: 'project' as const, id: 'demo' },
    { type: 'chat' as const, id: 'c1' },
    { type: 'user' as const, id: 'u1' },
  ];
  const prompt = store.memoryPrompt('bot-a', scopes, '部署命令是什么？');
  assert.match(prompt, /make release/);        // relevant item beats 40 newer ones
  assert.match(prompt, /偏好中文回复/);         // specific scope survives the budget
  assert.doesNotMatch(prompt, /无关事实 0\b/);  // some irrelevant items are dropped
  fs.rmSync(dir, { recursive: true, force: true });
});

test('existing bindings migrate to the default assistant', () => {
  const dir = temp();
  const file = path.join(dir, 'wardendeck.db');
  const db = new DatabaseSync(file);
  // Legacy schema, kept here to prove the migration renames the columns.
  db.exec(`CREATE TABLE bindings (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, platform TEXT NOT NULL,
    credential TEXT NOT NULL, channels TEXT NOT NULL, allow_from TEXT NOT NULL,
    require_mention INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1)`);
  db.prepare('INSERT INTO bindings VALUES(?,?,?,?,?,?,?,?)')
    .run('b1', 'demo', 'feishu', 'feishu_main', '["oc_1"]', '["ou_1"]', 1, 1);
  db.close();

  const store = Store.open(dir);
  const binding = store.snapshot().bindings[0];
  assert.equal(binding.assistant_id, 'default');
  assert.deepEqual(binding.allowed_users, ['ou_1']);
  assert.equal(binding.mention_only, true);
  assert.ok(store.assistantExists('default'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit tampering is detected', () => {
  const dir = temp();
  Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  const db = new DatabaseSync(path.join(dir, 'wardendeck.db'));
  db.prepare('UPDATE audit SET target = ? WHERE seq = 1').run('tampered');
  db.close();
  assert.equal(Store.open(dir).verifyAudit().ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('secrets are encrypted at rest and read back transparently', () => {
  const dir = temp();
  const { store } = Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  store.setSecret('feishu_main', 'cli_abc\nsuper-secret-value');
  assert.equal(store.getSecret('feishu_main'), 'cli_abc\nsuper-secret-value');

  const db = new DatabaseSync(path.join(dir, 'wardendeck.db'));
  const raw = String((db.prepare("SELECT value FROM secrets WHERE ref = 'feishu_main'").get() as any).value);
  db.close();
  assert.ok(raw.startsWith('enc:v1:'));
  assert.ok(!raw.includes('super-secret-value'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy plaintext secrets are encrypted on the next open', () => {
  const dir = temp();
  Store.init(dir, 'owner@example.com', '127.0.0.1:0');
  const db = new DatabaseSync(path.join(dir, 'wardendeck.db'));
  db.prepare("INSERT INTO secrets(ref, value) VALUES('legacy', 'plaintext-credential')").run();
  db.close();

  const store = Store.open(dir);
  assert.equal(store.getSecret('legacy'), 'plaintext-credential');

  const check = new DatabaseSync(path.join(dir, 'wardendeck.db'));
  const raw = String((check.prepare("SELECT value FROM secrets WHERE ref = 'legacy'").get() as any).value);
  check.close();
  assert.ok(raw.startsWith('enc:v1:'));
  assert.ok(!raw.includes('plaintext-credential'));
  fs.rmSync(dir, { recursive: true, force: true });
});
