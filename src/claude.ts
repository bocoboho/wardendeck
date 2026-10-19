import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, any>;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  /** Allow subsequent tool calls without prompting for this many minutes. */
  allowForMinutes?: number;
}

export type AgentEvent =
  | { type: 'tool_use'; name: string; input: Record<string, any> }
  | { type: 'tool_result'; text: string; isError: boolean }
  | { type: 'thinking'; text: string };

function toolResultText(block: any): string {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x: any) => typeof x === 'string' ? x : x?.text ?? '').join('\n');
  }
  return '';
}

type Turn = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  text: string;
  timer: NodeJS.Timeout;
};

/** Per-message limits: one user message may not run forever. */
const MAX_TURN_MS = 30 * 60_000;
const MAX_TOOL_CALLS = 100;

export class TurnLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnLimitError';
  }
}

/**
 * Paths the agent must not read or execute. Messaging bridges often keep bot
 * credentials in plain text on disk — an unrestricted agent can read them and
 * send messages as another bot. Callers pass WardenDeck's own data directory;
 * additional bridge directories can be configured with WARDENDECK_DENY_PATHS
 * (path-delimiter separated). The whole tree is cut off at the OS level rather
 * than trusting a prompt.
 */
function sandboxPaths(extra: string[]): string[] {
  const configured = (process.env.WARDENDECK_DENY_PATHS ?? '')
    .split(path.delimiter)
    .map(p => p.trim())
    .filter(Boolean);
  return [...new Set([...extra, ...configured])].filter(Boolean);
}

function sandboxProfile(extra: string[]): string {
  return '(version 1)(allow default)' + sandboxPaths(extra)
    .map(p => `(deny file-read* (subpath ${JSON.stringify(p)}))(deny process-exec (subpath ${JSON.stringify(p)}))`)
    .join('');
}

const WARDENDECK_PROMPT = [
  'You are running inside WardenDeck and talking to the user through Feishu/Lark.',
  'Your final answer is sent to the user automatically.',
  'Do NOT call other bot CLIs or any external messaging tool to send messages or files,',
  'and do not read or use other applications\' Feishu/Lark credentials.',
  'To send local images to the user, put one line per image in your final answer:',
  'AW_ATTACH: /absolute/path/to/image.png',
  '(jpg/jpeg/png/webp/gif/bmp, at most 10 images). WardenDeck will upload them with its own bot.',
].join(' ');

export class ClaudeSession {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderr = '';
  private sessionId = '';
  private current?: Turn;
  private autoApproveUntil = 0;
  private idleTimer?: NodeJS.Timeout;
  private turnTimer?: NodeJS.Timeout;
  private toolCallCount = 0;
  private closed = false;
  private onEvent?: (event: AgentEvent) => void;

  private memoryInjected = false;

  constructor(
    private workdir: string,
    private permissionMode: string,
    resumeId = '',
    private denyPaths: string[] = [],
    private memoryBlock = '',
  ) {
    this.sessionId = resumeId;
  }

  get sessionID(): string {
    return this.sessionId;
  }

  get mode(): string {
    return this.permissionMode;
  }

  async ask(
    prompt: string,
    onPermission: (req: PermissionRequest) => Promise<PermissionDecision>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<string> {
    if (this.closed) throw new Error('Claude session is closed');
    if (this.current) throw new Error('Claude session is busy');
    this.ensureProcess();
    this.clearIdle();

    return new Promise<string>((resolve, reject) => {
      const turn: Turn = { resolve, reject, text: '', timer: setTimeout(() => {}, 0) };
      clearTimeout(turn.timer);
      this.current = turn;
      this.toolCallCount = 0;
      this.armTimer();
      this.clearTurnTimer();
      this.turnTimer = setTimeout(() => {
        this.limitTurn(`单轮执行超过 ${MAX_TURN_MS / 60_000} 分钟，已停止。`);
      }, MAX_TURN_MS);
      this.turnTimer.unref();
      // Memory is injected as conversation context, not as part of the system
      // prompt. The system prompt stays byte-identical across sessions, which
      // keeps the prompt-cache prefix intact; only this user message changes.
      const content = this.memoryBlock && !this.memoryInjected
        ? `${this.memoryBlock}\n\n---\n\n${prompt}`
        : prompt;
      this.write({
        type: 'user',
        message: { role: 'user', content },
      });
      if (this.memoryBlock) this.memoryInjected = true;
      this.onPermission = onPermission;
      this.onEvent = onEvent;
    });
  }

  /**
   * Idle timeout, not a wall-clock limit: every stream-json message or tool
   * event re-arms it. A tool that hangs (e.g. osascript blocked on a macOS
   * automation prompt) stops producing output and is still cleaned up, while
   * a long but active task is allowed to keep running.
   */
  private armTimer() {
    const turn = this.current;
    if (!turn) return;
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      if (this.current !== turn) return;
      this.current = undefined;
      this.clearTurnTimer();
      this.kill();
      turn.reject(new Error('Claude Code 长时间无响应（10 分钟）'));
    }, 10 * 60_000);
    turn.timer.unref();
  }

  private pauseTimer() {
    if (this.current) clearTimeout(this.current.timer);
  }

  close() {
    this.closed = true;
    this.clearIdle();
    this.clearTurnTimer();
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(new Error('Claude session closed'));
      this.current = undefined;
    }
    this.kill();
  }

  private onPermission: (req: PermissionRequest) => Promise<PermissionDecision> =
    async () => ({ behavior: 'deny', message: 'No approval handler' });

  private ensureProcess() {
    if (this.child && !this.child.killed) return;
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
      '--append-system-prompt', WARDENDECK_PROMPT,
    ];
    if (this.permissionMode && this.permissionMode !== 'default') {
      args.push('--permission-mode', this.permissionMode);
    }
    if (this.sessionId) args.push('--resume', this.sessionId);

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // Claude Code's own auto memory is keyed by git repository, not by
    // assistant, so it would leak facts across bots sharing a repo.
    // WardenDeck owns memory in its database instead. Set
    // WARDENDECK_CLAUDE_AUTO_MEMORY=1 to opt back in.
    if (process.env.WARDENDECK_CLAUDE_AUTO_MEMORY !== '1' && !env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) {
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    }

    // sandbox-exec is available on macOS and applies to every tool child too.
    const sandbox = process.platform === 'darwin'
      && process.env.WARDENDECK_SANDBOX !== '0'
      && fs.existsSync('/usr/bin/sandbox-exec');
    const command = sandbox ? '/usr/bin/sandbox-exec' : 'claude';
    const commandArgs = sandbox ? ['-p', sandboxProfile(this.denyPaths), 'claude', ...args] : args;

    const child = spawn(command, commandArgs, {
      cwd: this.workdir, env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // own process group, so we can kill tool children
    });
    this.child = child;
    this.buffer = '';
    this.stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (line) void this.handleLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', err => this.fail(err));
    child.on('exit', code => {
      this.child = undefined;
      if (this.current) {
        this.fail(new Error(`Claude Code 退出（code ${code}）${this.stderr ? ': ' + this.stderr.trim().slice(-500) : ''}`));
      }
    });
  }

  private async handleLine(line: string) {
    let msg: Record<string, any>;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.session_id) this.sessionId = String(msg.session_id);
    // Any traffic from Claude means the turn is alive.
    if (this.current) this.armTimer();

    if (msg.type === 'control_request') {
      await this.handlePermission(msg);
      return;
    }
    if (msg.type === 'assistant' && this.current) {
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === 'text' && b.text) this.current.text += b.text;
          else if (b.type === 'thinking' && b.thinking) this.emit({ type: 'thinking', text: String(b.thinking) });
          else if (b.type === 'tool_use') {
            if (++this.toolCallCount > MAX_TOOL_CALLS) {
              this.limitTurn(`单轮工具调用超过 ${MAX_TOOL_CALLS} 次，已停止。`);
              return;
            }
            this.emit({ type: 'tool_use', name: String(b.name ?? 'tool'), input: b.input ?? {} });
          }
        }
      }
      return;
    }
    if (msg.type === 'user' && this.current) {
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type === 'tool_result') {
            this.emit({ type: 'tool_result', text: toolResultText(b), isError: !!b.is_error });
          }
        }
      }
      return;
    }
    if (msg.type === 'result' && this.current) {
      const turn = this.current;
      this.current = undefined;
      clearTimeout(turn.timer);
      this.clearTurnTimer();
      turn.resolve(String(msg.result ?? turn.text ?? ''));
      this.scheduleIdle();
    }
  }

  private async handlePermission(msg: Record<string, any>) {
    const request = msg.request ?? {};
    if (request.subtype !== 'can_use_tool') return;
    const requestId = String(msg.request_id ?? '');
    const toolName = String(request.tool_name ?? 'unknown');
    const input = request.input ?? {};
    if (!this.current) {
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId,
          response: { behavior: 'deny', message: '当前没有进行中的请求。' } },
      });
      return;
    }

    let decision: PermissionDecision;
    if (Date.now() < this.autoApproveUntil) {
      decision = { behavior: 'allow' };
    } else {
      // Waiting for a human is not a hang: suspend the idle timeout until
      // the approval comes back (the approval itself has its own TTL).
      this.pauseTimer();
      try {
        decision = await this.onPermission({ requestId, toolName, input });
      } catch {
        decision = { behavior: 'deny', message: '审批流程失败，已拒绝。' };
      }
    }
    if (this.current) this.armTimer();
    if (decision.behavior === 'allow' && decision.allowForMinutes) {
      this.autoApproveUntil = Date.now() + decision.allowForMinutes * 60_000;
    }
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: decision.message || '用户拒绝了该操作。' },
      },
    });
  }

  private emit(event: AgentEvent) {
    try { this.onEvent?.(event); } catch { /* progress is best-effort */ }
  }

  private write(value: unknown) {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  private fail(err: Error) {
    this.clearTurnTimer();
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(err);
      this.current = undefined;
    }
    this.kill();
    this.child = undefined;
  }

  /** Hard-stop the current turn: kill the agent process group and reject. */
  private limitTurn(message: string) {
    this.clearTurnTimer();
    const turn = this.current;
    this.current = undefined;
    if (!turn) {
      this.kill();
      return;
    }
    clearTimeout(turn.timer);
    this.kill();
    turn.reject(new TurnLimitError(message));
  }

  private clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = undefined;
  }

  private kill() {
    const child = this.child;
    this.child = undefined;
    if (!child || !child.pid) return;
    const pid = child.pid;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-pid, sig); // whole process group: kills tool children too
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    signal('SIGTERM');
    setTimeout(() => signal('SIGKILL'), 3000).unref();
  }

  private scheduleIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.kill(), 10 * 60_000);
    this.idleTimer.unref();
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
