import type { LSPServerConfig } from '../../types.js';
import type { ServerAdapter } from '../types.js';

/**
 * Adapter for SourceKit-LSP (Swift/C/C++ Language Server).
 *
 * SourceKit-LSP can be slow on large Swift projects, especially when using
 * compilation databases spanning many modules. This adapter extends timeouts
 * for operations that may take longer with large codebases.
 *
 * Automatically detected when the server command contains 'sourcekit-lsp'.
 */
export class SourceKitLSPAdapter implements ServerAdapter {
  readonly name = 'sourcekit-lsp';

  matches(config: LSPServerConfig): boolean {
    return config.command.some((c: string) => c.includes('sourcekit-lsp'));
  }

  getTimeout(method: string): number | undefined {
    const timeouts: Record<string, number> = {
      'textDocument/documentSymbol': 90000,
      'textDocument/definition': 60000,
      'textDocument/references': 120000,
      'textDocument/rename': 120000,
      'textDocument/hover': 90000,
      'workspace/symbol': 120000,
      'callHierarchy/incomingCalls': 90000,
      'callHierarchy/outgoingCalls': 90000,
      'textDocument/prepareCallHierarchy': 90000,
    };
    return timeouts[method];
  }
}
