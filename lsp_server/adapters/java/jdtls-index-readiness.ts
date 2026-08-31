import type { ILspAdapter } from '../../contracts/lsp-adapter.interface.js';

interface AwaitIndexResult {
  schemaVersion: number;
  status: string;
  severity?: number;
}

/** Wait for JDT's global Java index independently of classpath validation. */
export async function awaitJdtIndex(adapter: ILspAdapter, shardId: string): Promise<void> {
  let result: AwaitIndexResult;
  try {
    result = await adapter.request<AwaitIndexResult>('workspace/executeCommand', {
      command: 'gitnexus.java.awaitIndex',
      arguments: [],
    });
  } catch (error) {
    throw new Error(
      `[${shardId}] explicit JDT index readiness failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result?.schemaVersion !== 1 || result.status !== 'complete') {
    throw new Error(`[${shardId}] JDT index readiness returned an incompatible response`);
  }
}
