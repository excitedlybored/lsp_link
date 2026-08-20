/**
 * Framed JSON-RPC 2.0 Transport Channel over stdio.
 */

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export class JsonRpcChannel extends EventEmitter {
  private msgId = 0;
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>();
  private buffer = Buffer.alloc(0);

  constructor(private process: ChildProcess) {
    super();
    if (this.process.stdout) {
      this.process.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    }
    if (this.process.stderr) {
      this.process.stderr.on('data', () => {
        // Drain stderr
      });
    }
  }

  private handleData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEndIndex = this.buffer.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        break;
      }

      const headerText = this.buffer.subarray(0, headerEndIndex).toString('latin1');
      let contentLength = 0;

      for (const line of headerText.split('\r\n')) {
        if (line.toLowerCase().startsWith('content-length:')) {
          contentLength = parseInt(line.split(':')[1].trim(), 10);
        }
      }

      const totalMessageLength = headerEndIndex + 4 + contentLength;
      if (this.buffer.length < totalMessageLength) {
        break; // Wait for more data
      }

      const bodyBuffer = this.buffer.subarray(headerEndIndex + 4, totalMessageLength);
      this.buffer = this.buffer.subarray(totalMessageLength);

      try {
        const msg = JSON.parse(bodyBuffer.toString('utf-8'));
        this.dispatchMessage(msg);
      } catch (err) {
        // Ignore malformed JSON
      }
    }
  }

  private dispatchMessage(msg: any) {
    if (typeof msg.id === 'number' && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      this.emit('notification', msg);
    }
  }

  public sendRequest<T>(method: string, params: any, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      this.msgId += 1;
      const id = this.msgId;

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} (${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const raw = Buffer.from(payload, 'utf-8');
      const header = Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`, 'latin1');

      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.write(header);
        this.process.stdin.write(raw);
      } else {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error('Process stdin is not writable.'));
      }
    });
  }

  public sendNotification(method: string, params: any): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    const raw = Buffer.from(payload, 'utf-8');
    const header = Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`, 'latin1');

    if (this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.write(header);
      this.process.stdin.write(raw);
    }
  }
}
