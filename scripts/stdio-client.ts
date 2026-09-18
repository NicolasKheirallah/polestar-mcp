/**
 * Minimal MCP stdio test client shared by the smoke and demo-dump scripts:
 * spawns a server process, speaks newline-delimited JSON-RPC, and offers
 * typed helpers for the handshake and tool calls.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
  /** Machine-readable result envelope the server declares as its outputSchema. */
  structuredContent?: Record<string, unknown>;
  /** Present when the failure was a JSON-RPC protocol error rather than an in-band tool error. */
  protocolError?: { code: number; message: string };
}

export class StdioMcpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private elicitationAnswer: Record<string, unknown> = { action: 'decline' };
  private nextId = 1;
  private stderrBuf = '';

  private constructor(child: ChildProcess) {
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed) as JsonRpcMessage;
      // Server-initiated requests (elicitation) must be answered or the tool
      // call blocks until timeout. Tests choose by queueing an answer first.
      if (typeof msg.id === 'number' && typeof msg.method === 'string' && !this.pending.has(msg.id)) {
        this.handleServerRequest(msg.id, msg.method);
        return;
      }
      if (typeof msg.id === 'number') {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString();
    });
  }

  static spawn(args: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): StdioMcpClient {
    return new StdioMcpClient(
      spawn(process.execPath, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n',
      );
    });
  }

  async initialize(
    serverName: string,
    protocolVersion = '2025-06-18',
    capabilities: Record<string, unknown> = {},
  ): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion,
      capabilities,
      clientInfo: { name: 'polestar-mcp-test', version: '0.0.0' },
    });
    const name = (init.result?.serverInfo as { name?: string } | undefined)?.name;
    if (name !== serverName) throw new Error(`handshake failed: server name ${JSON.stringify(name)}`);
    this.notifyInitialized();
  }

  /** The content this test client returns when the server asks the user something. */
  answerElicitation(content: Record<string, unknown>): void {
    this.elicitationAnswer = { action: 'accept', content };
  }

  private handleServerRequest(id: number, method: string): void {
    const result = method === 'elicitation/create' ? this.elicitationAnswer : {};
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  notifyInitialized(): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools(): Promise<string[]> {
    const res = await this.request('tools/list', {});
    const tools = res.result?.tools as { name: string }[] | undefined;
    if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
    return tools.map((t) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) return { text: '', isError: true, protocolError: res.error };
    const structured = res.result?.structuredContent as Record<string, unknown> | undefined;
    const content = res.result?.content as { type: string; text?: string }[] | undefined;
    const text = Array.isArray(content) ? content.map((c) => c.text ?? '').join('\n') : '';
    return { text, isError: res.result?.isError === true, ...(structured !== undefined ? { structuredContent: structured } : {}) };
  }

  stderr(): string {
    return this.stderrBuf;
  }

  stop(): void {
    this.child.kill('SIGTERM');
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

export function assertDefined<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value as T;
}
