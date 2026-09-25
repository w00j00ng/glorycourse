import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDesktop } from '../../scripts/runtime-paths.mjs';

import { HttpError, writeHttpError } from './api/errors.ts';
import { LocalSessionGuard } from './api/local-session.ts';
import { createApiRouter } from './api/router.ts';
import { acquireInstanceLock } from './storage/instance-lock.ts';
import { openStore, type Store, type DatabaseState } from './storage/store.ts';

const LOOPBACK = '127.0.0.1';
const DEFAULT_UPLOAD_BYTES = 20 * 1024 * 1024;
const RESTORE_UPLOAD_BYTES = 512 * 1024 * 1024;

export type ApiRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  bodyFile?: string;
};
export type ApiResponse = {
  status: number;
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
};
export type ApiHandler = (
  request: ApiRequest,
  context: { store: Store | Pick<Store, 'read'> },
) => Promise<ApiResponse | undefined> | ApiResponse | undefined;

export const startLocalServer = async (options: {
  dataDirectory: string;
  staticDirectory: string;
  port?: number;
  uploadBytes?: number;
  apiHandler?: ApiHandler;
  instanceId?: string;
  version?: string;
  onProgress?: (message: string) => void;
  onClose?: () => Promise<void>;
}) => {
  const uploadBytes = options.uploadBytes ?? DEFAULT_UPLOAD_BYTES;
  if (!Number.isSafeInteger(uploadBytes) || uploadBytes < 1) {
    throw new Error('uploadBytes must be a positive safe integer');
  }
  await mkdir(options.dataDirectory, { recursive: true });
  const lock = await acquireInstanceLock(options.dataDirectory);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    options.onProgress?.('자료를 확인하고 있습니다.');
    const store = await openStore(join(options.dataDirectory, 'db.sqlite'), emptyStore(), {
      backupDirectory: join(options.dataDirectory, 'update-backups'),
      appVersion: options.version,
      onProgress: options.onProgress,
    });
    const apiHandler = options.apiHandler ?? createApiRouter(store, {
      dataDirectory: resolve(options.dataDirectory),
    });
    let guard: LocalSessionGuard;
    let stopping = false;
    let closing: Promise<void> | undefined;
    const active = new Map<IncomingMessage, Promise<void>>();
    const close = (): Promise<void> => {
      stopping = true;
      closing ??= (async () => {
        await closeServer(server!);
        await Promise.all(active.values());
        try { await options.onClose?.(); }
        finally { await lock.release(); }
      })();
      return closing;
    };
    const runtimeInfo = {
      application: 'glorycourse',
      instanceId: options.instanceId ?? randomUUID(),
      version: options.version ?? 'development',
      dataDirectory: resolve(options.dataDirectory),
    };
    server = createServer((request, response) => {
      const pending = handleRequest(request, response, {
        store,
        guard,
        staticDirectory: options.staticDirectory,
        uploadBytes,
        apiHandler,
        runtimeInfo,
        isStopping: () => stopping,
        shutdown: async () => {
          // Stop accepting connections first, but finish this response before awaiting close().
          const accepted = [...active].filter(([other]) => other !== request).map(([, task]) => task);
          void close().catch((error) => { console.error('Shutdown failed:', error.code ?? error.name); process.exitCode = 1; });
          await Promise.all(accepted);
        },
      });
      active.set(request, pending);
      void pending.finally(() => active.delete(request));
    });
    await listen(server, options.port ?? 0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local server address is unavailable');
    const authority = `${LOOPBACK}:${address.port}`;
    const origin = `http://${authority}`;
    guard = new LocalSessionGuard({ authority, origin });
    return {
      address: LOOPBACK,
      port: address.port,
      origin,
      store,
      close,
    };
  } catch (error) {
    if (server?.listening) await closeServer(server);
    await lock.release();
    throw error;
  }
};

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    store: Store;
    guard: LocalSessionGuard;
    staticDirectory: string;
    uploadBytes: number;
    apiHandler?: ApiHandler;
    runtimeInfo: { application: string; instanceId: string; version: string; dataDirectory: string };
    isStopping: () => boolean;
    shutdown: () => Promise<void>;
  },
): Promise<void> => {
  try {
    const url = requestUrl(request);
    const path = url.pathname;
    if (context.isStopping()) throw new HttpError(503, 'STOPPING', '프로그램이 종료 중입니다. 저장 완료 후 다시 시작하세요.');
    if (path === '/api/v1/session') {
      if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 메서드입니다.');
      context.guard.verifyRequest(request, { requireSession: false });
      request.resume();
      writeJson(response, 201, context.guard.issue(), { 'Cache-Control': 'no-store' });
      return;
    }
    if (path.startsWith('/api/v1/')) {
      context.guard.verifyRequest(request, { requireSession: true });
      const upload = path === '/api/v1/restores/preview' && request.method === 'POST'
        ? await readBodyFile(request, join(context.runtimeInfo.dataDirectory, 'recovery-work'), RESTORE_UPLOAD_BYTES)
        : undefined;
      const body = upload ? Buffer.alloc(0) : await readBody(request, context.uploadBytes);
      if (path === '/api/v1/shutdown') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST 요청만 허용합니다.');
        if (context.isStopping()) throw new HttpError(503, 'STOPPING', '프로그램이 종료 중입니다.');
        await context.shutdown();
        writeJson(response, 200, { state: 'stopped' }, { Connection: 'close', 'Cache-Control': 'no-store' });
        return;
      }
      if (path === '/api/v1/runtime' && request.method === 'GET') {
        writeJson(response, 200, context.runtimeInfo, { 'Cache-Control': 'no-store' });
        return;
      }
      if (path === '/api/v1/data-folder') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST 요청만 허용합니다.');
        await openDesktop(context.runtimeInfo.dataDirectory);
        response.writeHead(204);
        response.end();
        return;
      }
      const safe = request.method === 'GET' || request.method === 'HEAD';
      const handlerStore = safe ? { read: () => context.store.read() } : context.store;
      let result: ApiResponse | undefined;
      try {
        result = await context.apiHandler?.({
          method: request.method ?? 'GET',
          path,
          query: url.searchParams,
          headers: request.headers,
          body,
          bodyFile: upload?.file,
        }, { store: handlerStore });
      } finally {
        if (upload) await rm(upload.directory, { recursive: true, force: true });
      }
      if (!result) throw new HttpError(404, 'NOT_FOUND', '대상을 찾을 수 없습니다.');
      writeApiResponse(response, result, request.method === 'HEAD');
      return;
    }
    context.guard.verifyRequest(request, { requireSession: false });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 메서드입니다.');
    }
    await serveStatic(response, context.staticDirectory, path, request.method === 'HEAD');
  } catch (error) {
    if (!response.headersSent) writeHttpError(response, error);
    else response.destroy();
  }
};

const requestUrl = (request: IncomingMessage): URL => {
  try {
    return new URL(request.url ?? '/', 'http://local.invalid');
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', '요청 경로를 읽을 수 없습니다.');
  }
};

const readBody = async (request: IncomingMessage, limit: number): Promise<Buffer> => {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 허용 한도를 초과했습니다.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 허용 한도를 초과했습니다.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const readBodyFile = async (
  request: IncomingMessage,
  workDirectory: string,
  limit: number,
): Promise<{ directory: string; file: string }> => {
  if (request.headers['content-type']?.toLowerCase() !== 'application/vnd.sqlite3') {
    request.resume();
    throw new HttpError(400, 'BAD_REQUEST', 'SQLite 백업 파일이 필요합니다.');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 허용 한도를 초과했습니다.');
  }
  await mkdir(workDirectory, { recursive: true });
  const directory = await mkdtemp(join(workDirectory, 'upload-'));
  const file = join(directory, 'candidate.sqlite');
  const output = await open(file, 'wx', 0o600);
  let total = 0;
  let complete = false;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > limit) {
        request.resume();
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 허용 한도를 초과했습니다.');
      }
      await output.writeFile(bytes);
    }
    complete = true;
    return { directory, file };
  } finally {
    try { await output.close(); }
    finally { if (!complete) await rm(directory, { recursive: true, force: true }); }
  }
};

const serveStatic = async (
  response: ServerResponse,
  directory: string,
  requestPathname: string,
  head: boolean,
): Promise<void> => {
  const root = resolve(directory);
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestPathname);
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', '요청 경로를 읽을 수 없습니다.');
  }
  const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const child = relative(root, requested);
  if (child.startsWith('..') || isAbsolute(child)) throw new HttpError(404, 'NOT_FOUND', '대상을 찾을 수 없습니다.');
  let file = requested;
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    if (extname(pathname)) throw new HttpError(404, 'NOT_FOUND', '대상을 찾을 수 없습니다.');
    file = join(root, 'index.html');
  }
  const body = await readFile(file);
  response.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': body.byteLength,
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(head ? undefined : body);
};

const writeApiResponse = (response: ServerResponse, result: ApiResponse, head: boolean): void => {
  const body = result.body ?? Buffer.from(JSON.stringify(result.json ?? {}));
  response.writeHead(result.status, {
    'Content-Type': result.body ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    ...result.headers,
  });
  response.end(head ? undefined : body);
};

const writeJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void => {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    ...headers,
  });
  response.end(body);
};

const contentType = (file: string): string => ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}[extname(file).toLowerCase()] ?? 'application/octet-stream');

const listen = (server: ReturnType<typeof createServer>, port: number): Promise<void> => new Promise((resolveListen, reject) => {
  const onError = (error: Error) => reject(error);
  server.once('error', onError);
  server.listen(port, LOOPBACK, () => {
    server.off('error', onError);
    resolveListen();
  });
});

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> => new Promise((resolveClose, reject) => {
  server.close((error) => error ? reject(error) : resolveClose());
});

const emptyStore = (): DatabaseState => ({
  meta: { storeEpoch: randomUUID(), storeRevision: 0 },
  semesters: [],
  members: [],
  courses: [],
  semesterCourses: [],
  applications: [],
  applicationChoices: [],
  enrollments: [],
  allocationDrafts: [],
  allocationDraftItems: [],
  importBatches: [],
  finalizationReceipts: [],
  restoreReceipts: [],
});
