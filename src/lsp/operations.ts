import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { pathToUri, uriToPath } from '../utils.js';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Diagnostic,
  DocumentDiagnosticReport,
  DocumentSymbol,
  LSPLocation,
  Location,
  Position,
  ServerState,
  SymbolInformation,
  SymbolMatch,
} from './types.js';
import { SymbolKind } from './types.js';

// --- Symbol Utilities ---

export function symbolKindToString(kind: SymbolKind): string {
  const kindMap: Record<SymbolKind, string> = {
    [SymbolKind.File]: 'file',
    [SymbolKind.Module]: 'module',
    [SymbolKind.Namespace]: 'namespace',
    [SymbolKind.Package]: 'package',
    [SymbolKind.Class]: 'class',
    [SymbolKind.Method]: 'method',
    [SymbolKind.Property]: 'property',
    [SymbolKind.Field]: 'field',
    [SymbolKind.Constructor]: 'constructor',
    [SymbolKind.Enum]: 'enum',
    [SymbolKind.Interface]: 'interface',
    [SymbolKind.Function]: 'function',
    [SymbolKind.Variable]: 'variable',
    [SymbolKind.Constant]: 'constant',
    [SymbolKind.String]: 'string',
    [SymbolKind.Number]: 'number',
    [SymbolKind.Boolean]: 'boolean',
    [SymbolKind.Array]: 'array',
    [SymbolKind.Object]: 'object',
    [SymbolKind.Key]: 'key',
    [SymbolKind.Null]: 'null',
    [SymbolKind.EnumMember]: 'enum_member',
    [SymbolKind.Struct]: 'struct',
    [SymbolKind.Event]: 'event',
    [SymbolKind.Operator]: 'operator',
    [SymbolKind.TypeParameter]: 'type_parameter',
  };
  return kindMap[kind] || 'unknown';
}

export function getValidSymbolKinds(): string[] {
  return [
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enum_member',
    'struct',
    'event',
    'operator',
    'type_parameter',
  ];
}

export function stringToSymbolKind(kindStr: string): SymbolKind | null {
  const kindMap: Record<string, SymbolKind> = {
    file: SymbolKind.File,
    module: SymbolKind.Module,
    namespace: SymbolKind.Namespace,
    package: SymbolKind.Package,
    class: SymbolKind.Class,
    method: SymbolKind.Method,
    property: SymbolKind.Property,
    field: SymbolKind.Field,
    constructor: SymbolKind.Constructor,
    enum: SymbolKind.Enum,
    interface: SymbolKind.Interface,
    function: SymbolKind.Function,
    variable: SymbolKind.Variable,
    constant: SymbolKind.Constant,
    string: SymbolKind.String,
    number: SymbolKind.Number,
    boolean: SymbolKind.Boolean,
    array: SymbolKind.Array,
    object: SymbolKind.Object,
    key: SymbolKind.Key,
    null: SymbolKind.Null,
    enum_member: SymbolKind.EnumMember,
    struct: SymbolKind.Struct,
    event: SymbolKind.Event,
    operator: SymbolKind.Operator,
    type_parameter: SymbolKind.TypeParameter,
  };
  return kindMap[kindStr.toLowerCase()] || null;
}

export function flattenDocumentSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const flattened: DocumentSymbol[] = [];
  for (const symbol of symbols) {
    flattened.push(symbol);
    if (symbol.children) {
      flattened.push(...flattenDocumentSymbols(symbol.children));
    }
  }
  return flattened;
}

/**
 * Find a symbol by qualified name (e.g., "Memory.Address") by walking the
 * document symbol hierarchy. Returns matching leaf symbols.
 */
export function findSymbolByQualifiedName(
  symbols: DocumentSymbol[],
  components: string[]
): DocumentSymbol[] {
  if (components.length === 0) return [];

  const [head, ...rest] = components;
  const matches: DocumentSymbol[] = [];

  for (const symbol of symbols) {
    if (symbol.name === head) {
      if (rest.length === 0) {
        matches.push(symbol);
      } else if (symbol.children) {
        matches.push(...findSymbolByQualifiedName(symbol.children, rest));
      }
    }
  }

  return matches;
}

/**
 * Symbol kind priority for ranking matches. Lower is better.
 * Concrete type declarations rank higher than type parameters.
 */
const SYMBOL_KIND_PRIORITY: Record<number, number> = {
  [SymbolKind.Class]: 0,
  [SymbolKind.Struct]: 0,
  [SymbolKind.Enum]: 0,
  [SymbolKind.Interface]: 0,
  [SymbolKind.Function]: 1,
  [SymbolKind.Method]: 1,
  [SymbolKind.Constructor]: 1,
  [SymbolKind.Property]: 2,
  [SymbolKind.Field]: 2,
  [SymbolKind.Variable]: 2,
  [SymbolKind.Constant]: 2,
  [SymbolKind.EnumMember]: 2,
  [SymbolKind.Namespace]: 3,
  [SymbolKind.Module]: 3,
  [SymbolKind.Package]: 3,
  [SymbolKind.TypeParameter]: 4,
};

function getSymbolPriority(kind: SymbolKind): number {
  return SYMBOL_KIND_PRIORITY[kind] ?? 3;
}

/**
 * Sort symbol matches: exact name matches first, then by kind priority.
 */
function rankSymbolMatches(matches: SymbolMatch[], symbolName: string): SymbolMatch[] {
  return [...matches].sort((a, b) => {
    // Exact name match beats substring match
    const aExact = a.name === symbolName ? 0 : 1;
    const bExact = b.name === symbolName ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // Then sort by kind priority (concrete types first)
    return getSymbolPriority(a.kind) - getSymbolPriority(b.kind);
  });
}

export function isDocumentSymbolArray(
  symbols: DocumentSymbol[] | SymbolInformation[]
): symbols is DocumentSymbol[] {
  if (symbols.length === 0) return true;
  const firstSymbol = symbols[0];
  if (!firstSymbol) return true;
  return 'range' in firstSymbol && 'selectionRange' in firstSymbol;
}

export function findSymbolPositionInFile(filePath: string, symbol: SymbolInformation): Position {
  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    const range = symbol.location.range;
    const startLine = range.start.line;
    const endLine = range.end.line;

    logger.debug(
      `[DEBUG findSymbolPositionInFile] Searching for "${symbol.name}" in lines ${startLine}-${endLine}\n`
    );

    for (let lineNum = startLine; lineNum <= endLine && lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      if (!line) continue;

      let searchStart = 0;
      if (lineNum === startLine) {
        searchStart = range.start.character;
      }

      let searchEnd = line.length;
      if (lineNum === endLine) {
        searchEnd = range.end.character;
      }

      const searchText = line.substring(searchStart, searchEnd);
      const symbolIndex = searchText.indexOf(symbol.name);

      if (symbolIndex !== -1) {
        const actualCharacter = searchStart + symbolIndex;
        logger.debug(
          `[DEBUG findSymbolPositionInFile] Found "${symbol.name}" at line ${lineNum}, character ${actualCharacter}\n`
        );
        return { line: lineNum, character: actualCharacter };
      }
    }

    logger.debug(
      `[DEBUG findSymbolPositionInFile] Symbol "${symbol.name}" not found in range, using range start\n`
    );
    return range.start;
  } catch (error) {
    logger.debug(
      `[DEBUG findSymbolPositionInFile] Error reading file: ${error}, using range start\n`
    );
    return symbol.location.range.start;
  }
}

// --- LSP Operations ---

export async function findDefinition(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  logger.debug(
    `[DEBUG findDefinition] Requesting definition for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;

  const wasJustOpened = await serverState.documentManager.ensureOpen(filePath);
  if (wasJustOpened) {
    logger.debug(
      '[DEBUG findDefinition] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  logger.debug('[DEBUG findDefinition] Sending textDocument/definition request\n');
  const method = 'textDocument/definition';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  logger.debug(
    `[DEBUG findDefinition] Result type: ${typeof result}, isArray: ${Array.isArray(result)}\n`
  );

  if (Array.isArray(result)) {
    logger.debug(`[DEBUG findDefinition] Array result with ${result.length} locations\n`);
    if (result.length > 0) {
      logger.debug(
        `[DEBUG findDefinition] First location: ${JSON.stringify(result[0], null, 2)}\n`
      );
    }
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }
  if (result && typeof result === 'object' && 'uri' in result) {
    logger.debug(
      `[DEBUG findDefinition] Single location result: ${JSON.stringify(result, null, 2)}\n`
    );
    const location = result as LSPLocation;
    return [{ uri: location.uri, range: location.range }];
  }

  logger.debug('[DEBUG findDefinition] No definition found or unexpected result format\n');
  return [];
}

export async function findReferences(
  serverState: ServerState,
  filePath: string,
  position: Position,
  includeDeclaration = true
): Promise<Location[]> {
  logger.debug(
    `[DEBUG] findReferences for ${filePath} at ${position.line}:${position.character}, includeDeclaration: ${includeDeclaration}\n`
  );

  await serverState.initializationPromise;

  const wasJustOpened = await serverState.documentManager.ensureOpen(filePath);
  if (wasJustOpened) {
    logger.debug(
      '[DEBUG findReferences] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const method = 'textDocument/references';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
      context: { includeDeclaration },
    },
    timeout
  );

  logger.debug(
    `[DEBUG] findReferences result type: ${typeof result}, isArray: ${Array.isArray(result)}, length: ${Array.isArray(result) ? result.length : 'N/A'}\n`
  );

  if (result && Array.isArray(result) && result.length > 0) {
    logger.debug(`[DEBUG] First reference: ${JSON.stringify(result[0], null, 2)}\n`);
  } else if (result === null || result === undefined) {
    logger.debug('[DEBUG] findReferences returned null/undefined\n');
  } else {
    logger.debug(`[DEBUG] findReferences returned unexpected result: ${JSON.stringify(result)}\n`);
  }

  if (Array.isArray(result)) {
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }

  return [];
}

export async function renameSymbol(
  serverState: ServerState,
  filePath: string,
  position: Position,
  newName: string
): Promise<{
  changes?: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
}> {
  logger.debug(
    `[DEBUG renameSymbol] Requesting rename for ${filePath} at ${position.line}:${position.character} to "${newName}"\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  logger.debug('[DEBUG renameSymbol] Sending textDocument/rename request\n');
  const method = 'textDocument/rename';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
      newName,
    },
    timeout
  );

  logger.debug(
    `[DEBUG renameSymbol] Result type: ${typeof result}, hasChanges: ${result && typeof result === 'object' && 'changes' in result}, hasDocumentChanges: ${result && typeof result === 'object' && 'documentChanges' in result}\n`
  );

  if (result && typeof result === 'object') {
    if ('changes' in result) {
      const workspaceEdit = result as {
        changes: Record<
          string,
          Array<{ range: { start: Position; end: Position }; newText: string }>
        >;
      };
      const changeCount = Object.keys(workspaceEdit.changes || {}).length;
      logger.debug(`[DEBUG renameSymbol] WorkspaceEdit has changes for ${changeCount} files\n`);
      return workspaceEdit;
    }

    if ('documentChanges' in result) {
      const workspaceEdit = result as {
        documentChanges?: Array<{
          textDocument: { uri: string; version?: number };
          edits: Array<{
            range: { start: Position; end: Position };
            newText: string;
          }>;
        }>;
      };

      logger.debug(
        `[DEBUG renameSymbol] WorkspaceEdit has documentChanges with ${workspaceEdit.documentChanges?.length || 0} entries\n`
      );

      const changes: Record<
        string,
        Array<{ range: { start: Position; end: Position }; newText: string }>
      > = {};

      if (workspaceEdit.documentChanges) {
        for (const change of workspaceEdit.documentChanges) {
          if (change.textDocument && change.edits) {
            const uri = change.textDocument.uri;
            if (!changes[uri]) {
              changes[uri] = [];
            }
            changes[uri].push(...change.edits);
            logger.debug(`[DEBUG renameSymbol] Added ${change.edits.length} edits for ${uri}\n`);
          }
        }
      }

      return { changes };
    }
  }

  logger.debug('[DEBUG renameSymbol] No rename changes available\n');
  return {};
}

export async function getDocumentSymbols(
  serverState: ServerState,
  filePath: string
): Promise<DocumentSymbol[] | SymbolInformation[]> {
  logger.debug(`[DEBUG] Requesting documentSymbol for: ${filePath}\n`);

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/documentSymbol';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;

  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
    },
    timeout
  );

  logger.debug(
    `[DEBUG] documentSymbol result type: ${typeof result}, isArray: ${Array.isArray(result)}, length: ${Array.isArray(result) ? result.length : 'N/A'}\n`
  );

  if (result && Array.isArray(result) && result.length > 0) {
    logger.debug(`[DEBUG] First symbol: ${JSON.stringify(result[0], null, 2)}\n`);
  } else if (result === null || result === undefined) {
    logger.debug('[DEBUG] documentSymbol returned null/undefined\n');
  } else {
    logger.debug(`[DEBUG] documentSymbol returned unexpected result: ${JSON.stringify(result)}\n`);
  }

  if (Array.isArray(result)) {
    return result as DocumentSymbol[] | SymbolInformation[];
  }

  return [];
}

export async function findSymbolsByName(
  serverState: ServerState,
  filePath: string,
  symbolName: string,
  symbolKind?: string
): Promise<{ matches: SymbolMatch[]; warning?: string }> {
  logger.debug(
    `[DEBUG findSymbolsByName] Searching for symbol "${symbolName}" with kind "${symbolKind || 'any'}" in ${filePath}\n`
  );

  let validationWarning: string | undefined;
  let effectiveSymbolKind = symbolKind;
  if (symbolKind && stringToSymbolKind(symbolKind) === null) {
    const validKinds = getValidSymbolKinds();
    validationWarning = `⚠️ Invalid symbol kind "${symbolKind}". Valid kinds are: ${validKinds.join(', ')}. Searching all symbol types instead.`;
    effectiveSymbolKind = undefined;
  }

  const symbols = await getDocumentSymbols(serverState, filePath);
  const matches: SymbolMatch[] = [];

  logger.debug(`[DEBUG findSymbolsByName] Got ${symbols.length} symbols from documentSymbols\n`);

  // Check if symbolName is a qualified name (e.g., "Memory.Address")
  const qualifiedComponents = symbolName.includes('.') ? symbolName.split('.') : null;
  // The leaf name is what we match against flat symbol lists
  const leafName = qualifiedComponents
    ? qualifiedComponents[qualifiedComponents.length - 1]!
    : symbolName;

  if (isDocumentSymbolArray(symbols)) {
    logger.debug('[DEBUG findSymbolsByName] Processing DocumentSymbol[] (hierarchical format)\n');

    // If we have a qualified name, try hierarchical lookup first
    if (qualifiedComponents) {
      logger.debug(
        `[DEBUG findSymbolsByName] Trying qualified name lookup: ${qualifiedComponents.join('.')}\n`
      );
      const qualifiedMatches = findSymbolByQualifiedName(symbols, qualifiedComponents);
      for (const symbol of qualifiedMatches) {
        const kindMatches =
          !effectiveSymbolKind ||
          symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();
        if (kindMatches) {
          matches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: symbol.selectionRange.start,
            range: symbol.range,
            detail: symbol.detail,
          });
        }
      }
      if (matches.length > 0) {
        logger.debug(
          `[DEBUG findSymbolsByName] Qualified name lookup found ${matches.length} matches\n`
        );
      }
    }

    // Fall back to flat search if qualified lookup found nothing
    if (matches.length === 0) {
      const flatSymbols = flattenDocumentSymbols(symbols);
      logger.debug(`[DEBUG findSymbolsByName] Flattened to ${flatSymbols.length} symbols\n`);

      for (const symbol of flatSymbols) {
        const nameMatches = symbol.name === leafName || symbol.name.includes(leafName);
        const kindMatches =
          !effectiveSymbolKind ||
          symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

        if (nameMatches && kindMatches) {
          logger.debug(
            `[DEBUG findSymbolsByName] DocumentSymbol match: ${symbol.name} (kind=${symbolKindToString(symbol.kind)}) using selectionRange ${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}\n`
          );
          matches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: symbol.selectionRange.start,
            range: symbol.range,
            detail: symbol.detail,
          });
        }
      }
    }
  } else {
    logger.debug('[DEBUG findSymbolsByName] Processing SymbolInformation[] (flat format)\n');
    for (const symbol of symbols) {
      const nameMatches = symbol.name === leafName || symbol.name.includes(leafName);
      const kindMatches =
        !effectiveSymbolKind ||
        symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

      if (nameMatches && kindMatches) {
        logger.debug(
          `[DEBUG findSymbolsByName] SymbolInformation match: ${symbol.name} (kind=${symbolKindToString(symbol.kind)}) at ${symbol.location.range.start.line}:${symbol.location.range.start.character}\n`
        );
        const position = findSymbolPositionInFile(filePath, symbol);
        matches.push({
          name: symbol.name,
          kind: symbol.kind,
          position: position,
          range: symbol.location.range,
          detail: undefined,
        });
      }
    }
  }

  // Rank matches: exact names first, concrete types before type parameters
  const rankedMatches = rankSymbolMatches(matches, leafName);

  logger.debug(
    `[DEBUG findSymbolsByName] Found ${rankedMatches.length} matching symbols (ranked)\n`
  );

  let fallbackWarning: string | undefined;
  if (effectiveSymbolKind && rankedMatches.length === 0) {
    logger.debug(
      `[DEBUG findSymbolsByName] No matches found for kind "${effectiveSymbolKind}", trying fallback search for all kinds\n`
    );

    const fallbackMatches: SymbolMatch[] = [];

    if (isDocumentSymbolArray(symbols)) {
      const flatSymbols = flattenDocumentSymbols(symbols);
      for (const symbol of flatSymbols) {
        const nameMatches = symbol.name === leafName || symbol.name.includes(leafName);
        if (nameMatches) {
          fallbackMatches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: symbol.selectionRange.start,
            range: symbol.range,
            detail: symbol.detail,
          });
        }
      }
    } else {
      for (const symbol of symbols) {
        const nameMatches = symbol.name === leafName || symbol.name.includes(leafName);
        if (nameMatches) {
          const position = findSymbolPositionInFile(filePath, symbol);
          fallbackMatches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: position,
            range: symbol.location.range,
            detail: undefined,
          });
        }
      }
    }

    if (fallbackMatches.length > 0) {
      const ranked = rankSymbolMatches(fallbackMatches, leafName);
      const foundKinds = [...new Set(ranked.map((m) => symbolKindToString(m.kind)))];
      fallbackWarning = `⚠️ No symbols found with kind "${effectiveSymbolKind}". Found ${ranked.length} symbol(s) with name "${symbolName}" of other kinds: ${foundKinds.join(', ')}.`;
      rankedMatches.push(...ranked);
      logger.debug(
        `[DEBUG findSymbolsByName] Fallback search found ${ranked.length} additional matches\n`
      );
    }
  }

  const combinedWarning = [validationWarning, fallbackWarning].filter(Boolean).join(' ');
  return { matches: rankedMatches, warning: combinedWarning || undefined };
}

export async function getDiagnostics(
  serverState: ServerState,
  filePath: string
): Promise<Diagnostic[]> {
  logger.debug(`[DEBUG getDiagnostics] Requesting diagnostics for ${filePath}\n`);

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const fileUri = pathToUri(filePath);
  const cachedDiagnostics = serverState.diagnosticsCache.get(fileUri);

  if (cachedDiagnostics !== undefined) {
    logger.debug(
      `[DEBUG getDiagnostics] Returning ${cachedDiagnostics.length} cached diagnostics from publishDiagnostics\n`
    );
    return cachedDiagnostics;
  }

  logger.debug(
    '[DEBUG getDiagnostics] No cached diagnostics, trying textDocument/diagnostic request\n'
  );

  try {
    const result = await serverState.transport.sendRequest('textDocument/diagnostic', {
      textDocument: { uri: fileUri },
    });

    logger.debug(
      `[DEBUG getDiagnostics] Result type: ${typeof result}, has kind: ${result && typeof result === 'object' && 'kind' in result}\n`
    );

    if (result && typeof result === 'object' && 'kind' in result) {
      const report = result as DocumentDiagnosticReport;

      if (report.kind === 'full' && report.items) {
        logger.debug(
          `[DEBUG getDiagnostics] Full report with ${report.items.length} diagnostics\n`
        );
        return report.items;
      }
      if (report.kind === 'unchanged') {
        logger.debug('[DEBUG getDiagnostics] Unchanged report (no new diagnostics)\n');
        return [];
      }
    }

    logger.debug('[DEBUG getDiagnostics] Unexpected response format, returning empty array\n');
    return [];
  } catch (error) {
    logger.debug(
      `[DEBUG getDiagnostics] textDocument/diagnostic not supported or failed: ${error}. Waiting for publishDiagnostics...\n`
    );

    await serverState.diagnosticsCache.waitForIdle(fileUri, {
      maxWaitTime: 5000,
      idleTime: 300,
    });

    const diagnosticsAfterWait = serverState.diagnosticsCache.get(fileUri);
    if (diagnosticsAfterWait !== undefined) {
      logger.debug(
        `[DEBUG getDiagnostics] Returning ${diagnosticsAfterWait.length} diagnostics after waiting for idle state\n`
      );
      return diagnosticsAfterWait;
    }

    logger.debug(
      '[DEBUG getDiagnostics] No diagnostics yet, triggering publishDiagnostics with no-op change\n'
    );

    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      serverState.documentManager.sendChange(filePath, `${fileContent} `);
      serverState.documentManager.sendChange(filePath, fileContent);

      await serverState.diagnosticsCache.waitForIdle(fileUri, {
        maxWaitTime: 3000,
        idleTime: 300,
      });

      const diagnosticsAfterTrigger = serverState.diagnosticsCache.get(fileUri);
      if (diagnosticsAfterTrigger !== undefined) {
        logger.debug(
          `[DEBUG getDiagnostics] Returning ${diagnosticsAfterTrigger.length} diagnostics after triggering publishDiagnostics\n`
        );
        return diagnosticsAfterTrigger;
      }
    } catch (triggerError) {
      logger.debug(
        `[DEBUG getDiagnostics] Failed to trigger publishDiagnostics: ${triggerError}\n`
      );
    }

    return [];
  }
}

export async function hover(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<{
  contents: string | { kind: string; value: string };
  range?: { start: Position; end: Position };
} | null> {
  logger.debug(
    `[DEBUG hover] Requesting hover for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/hover';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (result && typeof result === 'object' && 'contents' in result) {
    return result as {
      contents: string | { kind: string; value: string };
      range?: { start: Position; end: Position };
    };
  }

  return null;
}

export async function workspaceSymbol(
  serverState: ServerState,
  query: string
): Promise<SymbolInformation[]> {
  logger.debug(`[DEBUG workspaceSymbol] Searching for "${query}"\n`);

  await serverState.initializationPromise;

  const method = 'workspace/symbol';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { query }, timeout);

  if (Array.isArray(result)) {
    return result as SymbolInformation[];
  }

  return [];
}

export async function findImplementation(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  logger.debug(
    `[DEBUG findImplementation] Requesting implementation for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/implementation';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (Array.isArray(result)) {
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }
  if (result && typeof result === 'object' && 'uri' in result) {
    const location = result as LSPLocation;
    return [{ uri: location.uri, range: location.range }];
  }

  return [];
}

export async function prepareCallHierarchy(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<CallHierarchyItem[]> {
  logger.debug(
    `[DEBUG prepareCallHierarchy] Requesting call hierarchy for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/prepareCallHierarchy';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (Array.isArray(result)) {
    return result as CallHierarchyItem[];
  }

  return [];
}

export async function incomingCalls(
  serverState: ServerState,
  item: CallHierarchyItem
): Promise<CallHierarchyIncomingCall[]> {
  logger.debug(`[DEBUG incomingCalls] Requesting incoming calls for ${item.name}\n`);

  await serverState.initializationPromise;

  const method = 'callHierarchy/incomingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyIncomingCall[];
  }

  return [];
}

export async function outgoingCalls(
  serverState: ServerState,
  item: CallHierarchyItem
): Promise<CallHierarchyOutgoingCall[]> {
  logger.debug(`[DEBUG outgoingCalls] Requesting outgoing calls for ${item.name}\n`);

  await serverState.initializationPromise;

  const method = 'callHierarchy/outgoingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyOutgoingCall[];
  }

  return [];
}
