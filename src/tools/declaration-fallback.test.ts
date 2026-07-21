import { describe, expect, it, jest } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LSPClient } from '../lsp-client.js';
import { pathToUri } from '../utils.js';
import { findReferencesTool } from './navigation.js';

/**
 * The name-based tools match a symbol against the DOCUMENT SYMBOLS of the file
 * they are given, so a file that merely uses a symbol used to dead-end with "no
 * symbols found" — a message that blames the index for a lookup problem. They now
 * fall back to a workspace search. These cover the branches that behaviour added.
 */

const USING_FILE = join(tmpdir(), 'src', 'uses-byte.ts');
const DECLARING_FILE = join(tmpdir(), 'src', 'byte.ts');
const OTHER_DECLARING_FILE = join(tmpdir(), 'src', 'other-byte.ts');

function workspaceSymbol(name: string, uri: string, containerName?: string) {
  return {
    name,
    kind: 5,
    containerName,
    location: {
      uri: pathToUri(uri),
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } },
    },
  };
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    findSymbolsByName: jest.fn(),
    findReferences: jest.fn(),
    findDefinition: jest.fn(),
    workspaceSymbol: jest.fn(),
    symbolKindToString: jest.fn(() => 'class'),
    syncFileContent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const asClient = (mock: unknown) => mock as LSPClient;

describe('find_references declaration fallback', () => {
  it('resolves to the declaring file when the symbol is not declared in the given file', async () => {
    const mockClient = createMockClient();
    // Absent in the file the caller passed, present in the declaring one.
    mockClient.findSymbolsByName.mockResolvedValueOnce({ matches: [] }).mockResolvedValueOnce({
      matches: [{ name: 'Byte', kind: 5, position: { line: 9, character: 4 } }],
    });
    mockClient.workspaceSymbol.mockResolvedValue([workspaceSymbol('Byte', DECLARING_FILE)]);
    mockClient.findReferences.mockResolvedValue([
      {
        uri: pathToUri(USING_FILE),
        range: { start: { line: 3, character: 2 }, end: { line: 3, character: 6 } },
      },
    ]);

    const result = await findReferencesTool.handler(
      { file_path: USING_FILE, symbol_name: 'Byte' },
      asClient(mockClient)
    );
    const text = result.content[0]?.text ?? '';

    expect(mockClient.workspaceSymbol).toHaveBeenCalledWith('Byte');
    // The redirection must be visible: results now come from a different file
    // than the caller named, and silently relocating them would misattribute them.
    expect(text).toContain('is not declared in');
    expect(text).toContain('resolved to');
    expect(mockClient.findReferences).toHaveBeenCalled();
    expect(mockClient.findReferences.mock.calls[0]?.[0]).toBe(resolve(DECLARING_FILE));
  });

  it('refuses to guess when several equally-good declarations exist in different files', async () => {
    const mockClient = createMockClient();
    mockClient.findSymbolsByName.mockResolvedValue({ matches: [] });
    mockClient.workspaceSymbol.mockResolvedValue([
      workspaceSymbol('Byte', DECLARING_FILE),
      workspaceSymbol('Byte', OTHER_DECLARING_FILE),
    ]);

    const result = await findReferencesTool.handler(
      { file_path: USING_FILE, symbol_name: 'Byte' },
      asClient(mockClient)
    );
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('equally-good candidates');
    // Reporting one candidate's references under the other's name is the failure
    // this branch exists to prevent, so nothing may be queried.
    expect(mockClient.findReferences).not.toHaveBeenCalled();
  });

  it('degrades to the original message when the server has no workspace/symbol support', async () => {
    // workspace/symbol is optional in LSP; cclsp serves many servers, so its
    // absence must not turn a helpful message into a thrown error.
    const mockClient = createMockClient({ workspaceSymbol: undefined });
    mockClient.findSymbolsByName.mockResolvedValue({ matches: [] });

    const result = await findReferencesTool.handler(
      { file_path: USING_FILE, symbol_name: 'nonExistent' },
      asClient(mockClient)
    );
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('No symbols found with name "nonExistent"');
    expect(mockClient.findReferences).not.toHaveBeenCalled();
  });

  it('does not run a workspace search when the symbol is declared in the given file', async () => {
    const mockClient = createMockClient();
    mockClient.findSymbolsByName.mockResolvedValue({
      matches: [{ name: 'Byte', kind: 5, position: { line: 1, character: 0 } }],
    });
    mockClient.findReferences.mockResolvedValue([
      {
        uri: pathToUri(DECLARING_FILE),
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
      },
    ]);

    const result = await findReferencesTool.handler(
      { file_path: DECLARING_FILE, symbol_name: 'Byte' },
      asClient(mockClient)
    );

    expect(mockClient.workspaceSymbol).not.toHaveBeenCalled();
    expect(result.content[0]?.text ?? '').not.toContain('resolved to');
  });
});
