import { execFileSync } from 'node:child_process';

export interface DetectedAgent {
  name: 'claudecode' | 'codex';
  binary: string;
  path: string;
  version: string;
}

const BINARIES: Array<{ name: DetectedAgent['name']; binary: string }> = [
  { name: 'claudecode', binary: 'claude' },
  { name: 'codex', binary: 'codex' },
];

export function detectAgents(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const item of BINARIES) {
    try {
      const binPath = execFileSync('which', [item.binary], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!binPath) continue;
      let version = 'unknown';
      try {
        version = execFileSync(binPath, ['--version'], {
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n')[0];
      } catch { /* version is optional */ }
      found.push({ name: item.name, binary: item.binary, path: binPath, version });
    } catch { /* not installed */ }
  }
  return found;
}

export function defaultAgent(): DetectedAgent['name'] {
  const agents = detectAgents();
  return agents.find(a => a.name === 'claudecode')?.name ?? agents[0]?.name ?? 'claudecode';
}
