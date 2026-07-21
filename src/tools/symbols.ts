import { uriToPath } from '../utils.js';
import { resolvePath, textResult } from './helpers.js';
import type { ToolDefinition } from './registry.js';

/** Results shown before truncating. The suppressed count is always reported. */
const WORKSPACE_SYMBOL_LIMIT = 50;

/** `Container.Name` when the server gave us a container, else the bare name. */
function qualifiedName(symbol: { name: string; containerName?: string }): string {
  return symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
}

/**
 * Rank a match against the leaf the user asked for. `workspace/symbol` matches
 * subsequences, so an unranked list buries the exact hit under thousands of
 * incidental ones — "URI" alone matched 50,200 symbols in a real workspace.
 */
function matchRank(name: string, leaf: string): number {
  if (name === leaf) return 0;
  if (name.toLowerCase() === leaf.toLowerCase()) return 1;
  if (name.startsWith(leaf)) return 2;
  if (name.toLowerCase().includes(leaf.toLowerCase())) return 3;
  return 4;
}

export const findWorkspaceSymbolsTool: ToolDefinition = {
  name: 'find_workspace_symbols',
  description:
    'Search for symbols across the entire workspace by name. Accepts a qualified ' +
    'name such as "Byte.Protocol" as well as a bare one. Exact matches rank first; ' +
    'compiler-generated symbols are hidden and the counts are reported.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Symbol name to search for. May be qualified ("Nest.Name") — the server ' +
          'matches leaf names only, so the container is applied as a filter here.',
      },
    },
    required: ['query'],
  },
  handler: async (args, client) => {
    const { query } = args as { query: string };

    try {
      // `workspace/symbol` matches against the leaf name only, so a qualified
      // query must be split: search the leaf, then constrain by the container the
      // server reports. Sending "Byte.Protocol" verbatim always returns nothing.
      const parts = query.split('.').filter(Boolean);
      const leaf = parts[parts.length - 1] ?? query;
      const container = parts.length > 1 ? parts[parts.length - 2] : undefined;

      const symbols = await client.workspaceSymbol(leaf);
      const total = symbols.length;

      // Results on read-only dependency copies are never actionable: editing one
      // changes a throwaway artifact that the next resolve discards. Swift units
      // are filtered at index-build time, but C symbols reach us through Clang
      // module units, which carry header paths inside checkouts.
      const editable = symbols.filter((sym) => !sym.location.uri.includes('/checkouts/'));
      const checkoutsHidden = total - editable.length;

      // Mangled names ($s...) are compiler-generated — largely macro-expanded test
      // scaffolding here. Keep them only if they are what was actually asked for.
      const wantsGenerated = query.startsWith('$s');
      let matches = wantsGenerated ? editable : editable.filter((sym) => !sym.name.startsWith('$s'));
      const generatedHidden = editable.length - matches.length;

      if (container) {
        matches = matches.filter(
          (sym) => sym.containerName === container || qualifiedName(sym).endsWith(query)
        );
      }

      // The same declaration can be indexed by more than one build; collapse them.
      const seen = new Set<string>();
      matches = matches.filter((sym) => {
        const key = `${qualifiedName(sym)}|${sym.location.uri}|${sym.location.range.start.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      matches.sort((a, b) => {
        const byRank = matchRank(a.name, leaf) - matchRank(b.name, leaf);
        return byRank !== 0 ? byRank : qualifiedName(a).localeCompare(qualifiedName(b));
      });

      if (matches.length === 0) {
        const note = generatedHidden
          ? ` (${generatedHidden} compiler-generated symbol(s) were hidden)`
          : '';
        const containerNote = container
          ? `\nThe server matched ${total} symbol(s) named like "${leaf}", but none were in "${container}".`
          : '';
        return textResult(`No symbols found matching "${query}"${note}.${containerNote}`);
      }

      const shown = matches.slice(0, WORKSPACE_SYMBOL_LIMIT);
      const symbolList = shown.map((sym) => {
        const filePath = uriToPath(sym.location.uri);
        const { start } = sym.location.range;
        return `• ${qualifiedName(sym)} (${client.symbolKindToString(sym.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}`;
      });

      // Every number that shaped this list is stated, so a short list is never
      // mistaken for a small result set.
      const notes: string[] = [`${total} raw match(es) from the server`];
      if (checkoutsHidden) notes.push(`${checkoutsHidden} on read-only checkout paths hidden`);
      if (generatedHidden) notes.push(`${generatedHidden} compiler-generated hidden`);
      if (container) notes.push(`filtered to container "${container}"`);
      if (matches.length > shown.length) {
        notes.push(`showing top ${shown.length} of ${matches.length} by relevance`);
      }

      return textResult(
        `Found ${matches.length} symbol(s) matching "${query}" [${notes.join('; ')}]:\n\n${symbolList.join('\n')}`
      );
    } catch (error) {
      return textResult(
        `Error searching symbols: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const prepareCallHierarchyTool: ToolDefinition = {
  name: 'prepare_call_hierarchy',
  description:
    'Get call hierarchy item at a position. Use this to prepare for incoming_calls or outgoing_calls.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file',
      },
      line: {
        type: 'number',
        description: 'The line number (1-indexed)',
      },
      character: {
        type: 'number',
        description: 'The character position in the line (1-indexed)',
      },
    },
    required: ['file_path', 'line', 'character'],
  },
  handler: async (args, client) => {
    const { file_path, line, character } = args as {
      file_path: string;
      line: number;
      character: number;
    };
    const absolutePath = resolvePath(file_path);

    try {
      const items = await client.prepareCallHierarchy(absolutePath, {
        line: line - 1,
        character: character - 1,
      });

      if (items.length === 0) {
        return textResult(`No call hierarchy item found at ${file_path}:${line}:${character}`);
      }

      const itemList = items.map((item) => {
        const filePath = uriToPath(item.uri);
        const { start } = item.selectionRange;
        return `• ${item.name} (${client.symbolKindToString(item.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}${item.detail ? ` - ${item.detail}` : ''}`;
      });

      return textResult(
        `Call hierarchy item(s) at ${file_path}:${line}:${character}:\n\n${itemList.join('\n')}`
      );
    } catch (error) {
      return textResult(
        `Error preparing call hierarchy: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const getIncomingCallsTool: ToolDefinition = {
  name: 'get_incoming_calls',
  description:
    'Find all functions/methods that call the function at a position. Requires prepare_call_hierarchy first.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file',
      },
      line: {
        type: 'number',
        description: 'The line number (1-indexed)',
      },
      character: {
        type: 'number',
        description: 'The character position in the line (1-indexed)',
      },
    },
    required: ['file_path', 'line', 'character'],
  },
  handler: async (args, client) => {
    const { file_path, line, character } = args as {
      file_path: string;
      line: number;
      character: number;
    };
    const absolutePath = resolvePath(file_path);

    try {
      const items = await client.prepareCallHierarchy(absolutePath, {
        line: line - 1,
        character: character - 1,
      });

      if (items.length === 0) {
        return textResult(`No call hierarchy item found at ${file_path}:${line}:${character}`);
      }

      const allCalls = [];
      for (const item of items) {
        const calls = await client.incomingCalls(item);
        for (const call of calls) {
          const filePath = uriToPath(call.from.uri);
          const { start } = call.from.selectionRange;
          allCalls.push(
            `• ${call.from.name} (${client.symbolKindToString(call.from.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}`
          );
        }
      }

      if (allCalls.length === 0) {
        return textResult(
          `No incoming calls found for the function at ${file_path}:${line}:${character}`
        );
      }

      return textResult(`Found ${allCalls.length} incoming call(s):\n\n${allCalls.join('\n')}`);
    } catch (error) {
      return textResult(
        `Error finding incoming calls: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const getOutgoingCallsTool: ToolDefinition = {
  name: 'get_outgoing_calls',
  description:
    'Find all functions/methods called by the function at a position. Requires prepare_call_hierarchy first.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file',
      },
      line: {
        type: 'number',
        description: 'The line number (1-indexed)',
      },
      character: {
        type: 'number',
        description: 'The character position in the line (1-indexed)',
      },
    },
    required: ['file_path', 'line', 'character'],
  },
  handler: async (args, client) => {
    const { file_path, line, character } = args as {
      file_path: string;
      line: number;
      character: number;
    };
    const absolutePath = resolvePath(file_path);

    try {
      const items = await client.prepareCallHierarchy(absolutePath, {
        line: line - 1,
        character: character - 1,
      });

      if (items.length === 0) {
        return textResult(`No call hierarchy item found at ${file_path}:${line}:${character}`);
      }

      const allCalls = [];
      for (const item of items) {
        const calls = await client.outgoingCalls(item);
        for (const call of calls) {
          const filePath = uriToPath(call.to.uri);
          const { start } = call.to.selectionRange;
          allCalls.push(
            `• ${call.to.name} (${client.symbolKindToString(call.to.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}`
          );
        }
      }

      if (allCalls.length === 0) {
        return textResult(
          `No outgoing calls found for the function at ${file_path}:${line}:${character}`
        );
      }

      return textResult(`Found ${allCalls.length} outgoing call(s):\n\n${allCalls.join('\n')}`);
    } catch (error) {
      return textResult(
        `Error finding outgoing calls: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const symbolTools: ToolDefinition[] = [
  findWorkspaceSymbolsTool,
  prepareCallHierarchyTool,
  getIncomingCallsTool,
  getOutgoingCallsTool,
];
