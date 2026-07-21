import { uriToPath } from '../utils.js';
import { resolvePath, textResult } from './helpers.js';
import type { ToolDefinition } from './registry.js';
import {
  WORKSPACE_SYMBOL_LIMIT,
  filterNotes,
  findSymbolsInWorkspace,
  formatSymbol,
} from './symbol-resolution.js';

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
      const filtered = await findSymbolsInWorkspace(client, query);

      if (filtered.matches.length === 0) {
        const containerNote = filtered.container
          ? `\nThe server matched ${filtered.total} symbol(s) named like "${filtered.leaf}", but none were in "${filtered.container}".`
          : '';
        return textResult(
          `No symbols found matching "${query}" [${filterNotes(filtered)}].${containerNote}`
        );
      }

      const shown = filtered.matches.slice(0, WORKSPACE_SYMBOL_LIMIT);
      const symbolList = shown.map((sym) => formatSymbol(client, sym));

      return textResult(
        `Found ${filtered.matches.length} symbol(s) matching "${query}" [${filterNotes(filtered, shown.length)}]:\n\n${symbolList.join('\n')}`
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
