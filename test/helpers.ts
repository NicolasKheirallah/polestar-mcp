import type { Transport, TransportRequest, TransportResponse } from '../src/transport.js';

export interface RecordedCall {
  url: string;
  request: TransportRequest;
}

/** Scripted transport: every fetch consumes the next response and records the call. */
export class ScriptedTransport implements Transport {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly responses: TransportResponse[]) {}

  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    this.calls.push({ url, request });
    const next = this.responses.shift();
    if (next === undefined) throw new Error(`unexpected extra request to ${url}`);
    return next;
  }
}

export function ok(body: unknown): TransportResponse {
  return { status: 200, body: JSON.stringify(body) };
}

export function tokenBody(token: string): TransportResponse {
  return ok({ accessToken: token, expiresIn: 3600, tokenType: 'Bearer' });
}
