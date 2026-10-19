import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgents } from './agents.js';
import type { Store } from './store.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function portFree(bind: string): Promise<{ ok: boolean; detail: string }> {
  const i = bind.lastIndexOf(':');
  const host = i > 0 ? bind.slice(0, i) : '127.0.0.1';
  const port = Number(bind.slice(i + 1));
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', err => resolve({ ok: false, detail: err.message }));
    srv.once('listening', () => srv.close(() => resolve({ ok: true, detail: `${bind} is free` })));
    srv.listen(port, host);
  });
}

export async function runChecks(store: Store): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) =>
    checks.push({ name, ok, detail, fix });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node version', major > 22 || (major === 22 && minor >= 13),
    process.versions.node, 'upgrade to Node.js >= 22.13');

  const info = fs.statSync(store.dir);
  add('data dir', (info.mode & 0o077) === 0, store.dir, `chmod 700 ${store.dir}`);

  add('master key', fs.existsSync(path.join(store.dir, 'master.key')),
    path.join(store.dir, 'master.key'), 'run `wardendeck init` again');

  const port = await portFree(store.bind);
  if (port.ok) {
    add('listen address', true, port.detail);
  } else {
    let ours = false;
    try {
      const res = await fetch(`http://${store.bind}/api/v1/state`, { signal: AbortSignal.timeout(1500) });
      ours = res.status === 401;
    } catch { /* not ours */ }
    add('listen address', ours, ours ? `${store.bind} in use by WardenDeck` : port.detail,
      'change bind or stop the process using it');
  }

  const agents = detectAgents();
  add('agent CLI', agents.length > 0,
    agents.length ? agents.map(a => `${a.name} ${a.version}`).join(', ') : 'none found',
    'install Claude Code or Codex and run it once to log in');

  const web = fs.existsSync(path.join(rootDir, 'web', 'index.html'));
  add('web assets', web, web ? 'web/index.html' : 'missing', 'reinstall the package');

  const refs = store.secrets();
  let secretsOk = true;
  let secretsDetail = `${refs.length} configured`;
  try {
    for (const ref of refs) store.getSecret(ref);
  } catch (err) {
    secretsOk = false;
    secretsDetail = `${refs.length} configured, decryption failed: ${err instanceof Error ? err.message : err}`;
  }
  add('secrets', secretsOk, secretsDetail,
    secretsOk ? '`wardendeck secret set <ref>`' : 'master.key mismatch; restore it or re-enter credentials');
  const snap = store.snapshot();
  add('projects', true, `${snap.counts.projects} configured`, '`wardendeck project create ...`');
  add('bindings', true, `${snap.counts.bindings} configured`, '`wardendeck platform bind ...`');
  return checks;
}
