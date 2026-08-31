import type { ILspAdapter } from '../../contracts/lsp-adapter.interface.js';

/** Add bounded process metadata and stderr context to a JDT startup failure. */
export function formatJdtlsProcessFailure(reason: string, adapter: ILspAdapter): string {
  const metadata = adapter.getSessionMetadata();
  const processDetail = [
    metadata.processId !== undefined ? `pid=${metadata.processId}` : undefined,
    metadata.processExitCode !== null && metadata.processExitCode !== undefined
      ? `exitCode=${metadata.processExitCode}` : undefined,
    metadata.processSignal ? `signal=${metadata.processSignal}` : undefined,
  ].filter(Boolean).join(', ');
  const stderr = metadata.processStderrTail?.trim();
  return `${reason}${processDetail ? ` (${processDetail})` : ''}`
    + (stderr && !reason.includes('stderr tail:')
      ? `\nJDT stderr tail:\n${stderr.slice(-8 * 1024)}` : '');
}
