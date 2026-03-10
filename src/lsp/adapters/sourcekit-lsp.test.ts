import { describe, expect, test } from 'bun:test';
import { SourceKitLSPAdapter } from './sourcekit-lsp.js';

describe('SourceKitLSPAdapter', () => {
  const adapter = new SourceKitLSPAdapter();

  test('should have correct name', () => {
    expect(adapter.name).toBe('sourcekit-lsp');
  });

  test('should match sourcekit-lsp command', () => {
    expect(adapter.matches({ extensions: ['swift'], command: ['sourcekit-lsp'] })).toBe(true);
    expect(
      adapter.matches({
        extensions: ['swift'],
        command: ['/usr/bin/sourcekit-lsp', '--log-level', 'debug'],
      })
    ).toBe(true);
  });

  test('should not match other servers', () => {
    expect(adapter.matches({ extensions: ['py'], command: ['pylsp'] })).toBe(false);
    expect(
      adapter.matches({ extensions: ['ts'], command: ['typescript-language-server', '--stdio'] })
    ).toBe(false);
  });

  test('should return extended timeouts for slow operations', () => {
    expect(adapter.getTimeout('textDocument/documentSymbol')).toBe(90000);
    expect(adapter.getTimeout('textDocument/references')).toBe(120000);
    expect(adapter.getTimeout('textDocument/definition')).toBe(60000);
    expect(adapter.getTimeout('textDocument/hover')).toBe(90000);
    expect(adapter.getTimeout('workspace/symbol')).toBe(120000);
    expect(adapter.getTimeout('textDocument/rename')).toBe(120000);
    expect(adapter.getTimeout('callHierarchy/incomingCalls')).toBe(90000);
    expect(adapter.getTimeout('callHierarchy/outgoingCalls')).toBe(90000);
    expect(adapter.getTimeout('textDocument/prepareCallHierarchy')).toBe(90000);
  });

  test('should return undefined for methods without custom timeout', () => {
    expect(adapter.getTimeout('textDocument/completion')).toBeUndefined();
    expect(adapter.getTimeout('textDocument/formatting')).toBeUndefined();
  });
});
