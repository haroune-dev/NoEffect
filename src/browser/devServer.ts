import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { logger } from '../utils/logger';
import { RETRY_POLICY } from '../session/policy';
import { sleep } from '../session/timing';
import { fromServedPath } from '../services/companionUrl';

export class DevServer {
  private server: http.Server | null = null;
  private portValue: number = 0;
  private root: string = '';
  private readonly virtualFiles: Map<string, string> = new Map();
  /** Every open connection, tracked so `stop()` can always release them. */
  private readonly sockets = new Set<net.Socket>();

  /** URL prefix for in-memory pages (served without touching disk). */
  static readonly VIRTUAL_PREFIX = '/__noeffect__/';

  /**
   * Serve a generated page from memory (e.g. the analysis wrapper for a
   * standalone CSS file). The page is reachable at
   * `{VIRTUAL_PREFIX}{name}` and replaces any disk file of that name.
   */
  setVirtualFile(name: string, content: string): void {
    this.virtualFiles.set(name, content);
  }

  /**
   * Start the HTTP server. The server stays alive across analyses: later
   * fixture changes only re-root it via {@link setRoot}, so the port never
   * changes and no second server is ever spawned.
   *
   * The server binds loopback-only (127.0.0.1), uses an ephemeral port, and
   * answers only files that resolve inside the configured root - path
   * traversal is rejected before any filesystem access. A rare port race
   * (dev_server_start policy) retries on a fresh ephemeral port.
   */
  async start(fixturePath: string): Promise<number> {
    this.root = fixturePath;
    logger.info(`[DevServer] Serving ${fixturePath}`);
    const attempts = 1 + RETRY_POLICY.dev_server_start.maxRetries;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await sleep(150 * attempt);
        logger.warn(`[DevServer] Retrying start (attempt ${attempt + 1})`);
      }
      const ctx = this.startCtx(fixturePath);
      try {
        const port = await ctx.listening;
        this.server = ctx.server;
        return port;
      } catch (err) {
        lastError = err;
        await this.closeServer(ctx.server);
        if (isAddressInUse(err)) {
          continue; // a port race — retry on a fresh ephemeral port
        }
        throw err;
      }
    }
    throw lastError;
  }

  private startCtx(_fixturePath: string): { server: http.Server; listening: Promise<number> } {
    const server = http.createServer((req, res) => this.handleRequest(req, res));
    server.on('connection', (socket: net.Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const listening = new Promise<number>((resolve, reject) => {
      server.on('error', (err) => {
        logger.error(`DevServer error: ${err.message}`);
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          this.portValue = address.port;
          logger.info(`DevServer listening on port ${this.portValue}`);
          resolve(address.port);
        } else {
          reject(new Error('Failed to get port from DevServer'));
        }
      });
    });
    return { server, listening };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestUrl = req.url ?? '/';

    // Virtual pages (generated analysis wrappers) are served first and
    // never touch the filesystem.
    if (requestUrl.startsWith(DevServer.VIRTUAL_PREFIX)) {
      // Browser-normalized requests may strip a `?query`/`#fragment` or
      // carry the percent-DECODED name while the registry holds the
      // encoded form (P3-LOG-34) — try the exact name first, then the
      // decoded one.
      const name = requestUrl
        .slice(DevServer.VIRTUAL_PREFIX.length)
        .split('?')[0]
        .split('#')[0];
      let content = this.virtualFiles.get(name);
      if (content === undefined) {
        try {
          content = this.virtualFiles.get(decodeURIComponent(name));
        } catch {
          content = undefined;
        }
      }
      if (content !== undefined) {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const filePath = this.resolveRequestPath(requestUrl);
    if (filePath === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const ext = path.extname(filePath);
      let contentType = 'text/html';
      if (ext === '.css') contentType = 'text/css';
      else if (ext === '.js') contentType = 'text/javascript';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  }

  /**
   * Map a request URL to a disk path that stays inside the root.
   *
   * The mapping is the shared URL model (`fromServedPath`): in-bounds `..`
   * segments collapse (matching the normalized URL a browser requests for
   * cross-directory hrefs like `../css/x.css`), while anything that could
   * escape the root — raw or encoded traversal, backslashes, null bytes,
   * malformed percent-encoding — returns null and is answered with 400.
   */
  private resolveRequestPath(requestUrl: string): string | null {
    return fromServedPath(this.root, requestUrl);
  }

  /**
   * Point the already-running server at a different fixture root. Requests
   * are answered from disk on each request, so a page reload after re-rooting
   * transparently serves the new fixture's files.
   */
  setRoot(fixturePath: string): void {
    if (this.root !== fixturePath) {
      this.root = fixturePath;
      logger.info(`[DevServer] Root changed to ${fixturePath}`);
    }
  }

  /** The port the server is listening on (0 until started). */
  get port(): number {
    return this.portValue;
  }

  /** Whether the HTTP server is currently running. */
  get isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Stop the server deterministically: destroy every tracked socket so no
   * keep-alive connection can hold the port, then close the server and
   * release the port. Bounded by the graceful_close policy.
   */
  async stop(): Promise<void> {
    this.virtualFiles.clear();
    const server = this.server;
    this.server = null;
    this.portValue = 0;
    if (!server) {
      return;
    }
    await this.closeServer(server);
    logger.info('DevServer stopped.');
  }

  private closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      // Force-destroy idle/keep-alive sockets so close() can complete.
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
      let settled = false;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(fallbackTimer);
        resolve();
      };
      server.close(() => settle());
      // Bounded: a stuck close must never hang the caller. The timer is
      // cleared when close() finishes first, so it neither fires later as a
      // no-op nor keeps the event loop referenced for the full timeout
      // (P3-PERF-35).
      const fallbackTimer = setTimeout(() => settle(), RETRY_POLICY.graceful_close.timeoutMs);
      fallbackTimer.unref();
    });
  }
}

function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}