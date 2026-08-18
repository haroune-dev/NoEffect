import { logger } from '../utils/logger';
import WebSocket from 'ws';

export class CdpClient {
  private connected: boolean = false;
  private ws: WebSocket | null = null;
  private messageId: number = 1;
  private pendingRequests: Map<number, { resolve: (val: unknown) => void, reject: (err: unknown) => void }> = new Map();
  private eventListeners: Map<string, Array<(params: unknown) => void>> = new Map();
  private connectionClosedListeners: Array<() => void> = [];

  /**
   * Connect to a Chromium instance at the given WebSocket URL.
   */
  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.on('open', () => {
        logger.info(`[CDP] Connected to ${wsUrl}`);
        this.connected = true;
        resolve();
      });

      socket.on('message', (data) => {
        // A single malformed frame must never crash the handler (P2-BUG-11):
        // it is logged and ignored — CDP is line-oriented JSON, so the next
        // well-formed frame continues the protocol stream.
        let message: {
          id?: number;
          method?: string;
          result?: unknown;
          error?: unknown;
          params?: unknown;
        };
        try {
          message = JSON.parse(data.toString());
        } catch {
          logger.warn('[CDP] Ignoring malformed WebSocket frame');
          return;
        }
        
        if (message.id !== undefined) {
          const req = this.pendingRequests.get(message.id);
          if (req) {
            this.pendingRequests.delete(message.id);
            if (message.error) {
              req.reject(message.error);
            } else {
              req.resolve(message.result);
            }
          }
        } else if (message.method) {
          const listeners = this.eventListeners.get(message.method);
          if (listeners) {
            for (const listener of listeners) {
              listener(message.params);
            }
          }
        }
      });

      socket.on('error', (err) => {
        // Only the current socket may mutate session state (same stale-socket
        // guard as the close handler).
        if (this.ws !== socket) {
          return;
        }
        logger.error(`[CDP] WebSocket error: ${err.message}`);
        const wasConnected = this.connected;
        this.connected = false;
        // A transport that errors without closing must never leave callers
        // hanging: every in-flight request fails immediately (P2-BUG-11),
        // so the LifecycleManager can detect the loss and recover.
        this.pendingRequests.forEach((req) => req.reject(err));
        this.pendingRequests.clear();
        if (!wasConnected) reject(err);
      });

      socket.on('close', (code: number, reason: Buffer) => {
        // Only the current socket may mutate session state: the close event
        // of a replaced socket (after a reconnect) must never touch the new
        // session's `connected` flag or in-flight requests.
        if (this.ws !== socket) {
          return;
        }
        this.connected = false;
        // A dead session must never leave callers hanging: every request
        // that was in flight fails immediately so the LifecycleManager can
        // detect the loss and recover instead of waiting forever. The close
        // code is attached as an explicit signal for the failure classifier.
        const closeCode = typeof code === 'number' ? code : undefined;
        const closeReason =
          typeof reason === 'string' || typeof reason === 'undefined'
            ? (reason as string | undefined)
            : reason.toString();
        this.pendingRequests.forEach((req) => {
          const err: Error & {
            wsCloseCode?: number;
            wsCloseReason?: string;
          } = new Error('CDP WebSocket closed while a request was in flight');
          if (closeCode !== undefined) {
            err.wsCloseCode = closeCode;
          }
          if (closeReason) {
            err.wsCloseReason = closeReason;
          }
          req.reject(err);
        });
        this.pendingRequests.clear();
        logger.info(`[CDP] WebSocket closed${closeCode !== undefined ? ` (code ${closeCode})` : ''}`);
        for (const listener of this.connectionClosedListeners) {
          listener();
        }
      });
    });
  }

  /**
   * Whether the client is currently connected.
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a CDP command and return the result.
   */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.ws) {
      throw new Error('CDP Client is not connected');
    }

    const id = this.messageId++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(message);
    });
  }

  /**
   * Listen to a specific CDP event.
   */
  on(method: string, listener: (params: unknown) => void): void {
    let listeners = this.eventListeners.get(method);
    if (!listeners) {
      listeners = [];
      this.eventListeners.set(method, listeners);
    }
    listeners.push(listener);
  }

  /**
   * Remove a specific CDP event listener.
   */
  off(method: string, listener: (params: unknown) => void): void {
    const listeners = this.eventListeners.get(method);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Register a callback invoked whenever the underlying WebSocket closes
   * (crash, browser exit, network loss). Used by the LifecycleManager to
   * mark the session degraded and schedule recovery.
   */
  onConnectionClosed(listener: () => void): void {
    this.connectionClosedListeners.push(listener);
  }

  /**
   * Disconnect from the browser.
   *
   * Connection-closed listeners are NOT detached here: the stale-socket
   * guard in the close handler already prevents a deliberate shutdown from
   * being reported as a session loss (the socket is replaced by `null`
   * before its close event fires).
   */
  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.pendingRequests.forEach(req => req.reject(new Error('Disconnected')));
    this.pendingRequests.clear();
    this.eventListeners.clear();
    logger.info('[CDP] disconnected');
  }

  dispose(): void {
    this.disconnect();
  }
}

