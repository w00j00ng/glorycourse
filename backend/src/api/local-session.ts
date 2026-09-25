import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { HttpError } from './errors.ts';

const SESSION_HEADER = 'x-glorycourse-session';

export class LocalSessionGuard {
  readonly #authority: string;
  readonly #origin: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #sessions = new Map<string, number>();

  constructor(options: { authority: string; origin: string; now?: () => Date; ttlMs?: number }) {
    this.#authority = options.authority.toLowerCase();
    this.#origin = options.origin;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  }

  verifyRequest(request: IncomingMessage, options: { requireSession: boolean }): void {
    if (!isLoopback(request.socket.remoteAddress)) throw forbidden();
    if (request.headers.host?.toLowerCase() !== this.#authority) throw forbidden();
    const origin = singleHeader(request.headers.origin);
    const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
    if ((unsafe && origin !== this.#origin) || (origin !== undefined && origin !== this.#origin)) {
      throw forbidden();
    }
    if (!options.requireSession) return;
    const token = singleHeader(request.headers[SESSION_HEADER]);
    if (!token || !this.#sessionValid(token)) throw forbidden();
  }

  issue(): { token: string; expiresAt: string } {
    const now = this.#now().getTime();
    for (const [token, expiresAt] of this.#sessions) {
      if (expiresAt <= now) this.#sessions.delete(token);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.#ttlMs;
    this.#sessions.set(token, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  #sessionValid(provided: string): boolean {
    const providedBytes = Buffer.from(provided);
    for (const [token, expiresAt] of this.#sessions) {
      const expectedBytes = Buffer.from(token);
      if (
        expiresAt > this.#now().getTime()
        && providedBytes.byteLength === expectedBytes.byteLength
        && timingSafeEqual(providedBytes, expectedBytes)
      ) return true;
    }
    return false;
  }
}

const singleHeader = (value: string | string[] | undefined): string | undefined => (
  Array.isArray(value) ? undefined : value
);

const isLoopback = (address: string | undefined): boolean => (
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
);

const forbidden = (): HttpError => new HttpError(
  403,
  'LOCAL_REQUEST_FORBIDDEN',
  '허용되지 않은 로컬 요청입니다.',
);
