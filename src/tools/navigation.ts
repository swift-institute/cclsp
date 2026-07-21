import { logger } from '../logger.js';
import type { LSPClient } from '../lsp-client.js';
import { formatLocations, resolvePath, textResult, withWarning } from './helpers.js';
import type { ToolDefinition } from './registry.js';
import { filterNotes, findDeclaringFile, formatSymbol } from './symbol-resolution.js';

/**
 * Resolve a symbol that is not declared in the file the caller supplied.
 *
 * These tools match a name against the DOCUMENT SYMBOLS of the given file, so a
 * file that merely uses the symbol yields nothing — a silent dead end whose
 * message ("no symbols found") points at the index rather than at the lookup.
 * Rather than make every caller run a workspace search by hand, do it here.
 *
 * Returns either a file to retry against, or the text to hand back. Ambiguity is
 * always handed back: with several equally-good candidates in different files,
 * picking one would report a different symbol's results under the asked-for name.
 */
async function resolveElsewhere(
  client: LSPClient,
  toolLabel: string,
  filePath: string,
  symbolName: string,
  symbolKind?: string
): Promise<{ retryPath: string; note: string } | { text: string }> {
  // Every failure path keeps this prefix, so the message a caller sees when a
  // symbol cannot be located stays the same regardless of whether the workspace
  // search ran, failed, or was unavailable.
  const notFoundHere = `No symbols found with name "${symbolName}"${symbolKind ? ` and kind "${symbolKind}"` : ''} in ${filePath}.`;

  let lookup: Awaited<ReturnType<typeof findDeclaringFile>>;
  try {
    // `workspace/symbol` is optional in LSP and cclsp serves many servers, so a
    // server without it must degrade to the old message rather than throw.
    lookup = await findDeclaringFile(client, symbolName, symbolKind);
  } catch (error) {
    return {
      text: `${notFoundHere} A workspace search for its declaration was not possible (${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  if (lookup.outcome === 'not-found') {
    return {
      text: `${notFoundHere} A workspace search found no declaration anywhere either [${filterNotes(lookup.filtered)}].\nIf the index is still warming, repeating the query will return more ([NAV-002]).`,
    };
  }

  if (lookup.outcome === 'ambiguous') {
    const list = lookup.candidates.map((sym) => formatSymbol(client, sym)).join('\n');
    return {
      text: `${notFoundHere} The workspace has ${lookup.candidates.length} equally-good candidates in different files [${filterNotes(lookup.filtered)}]:\n\n${list}\n\nRe-run ${toolLabel} with file_path set to the declaration you mean — reporting one of these as if it were the others would attribute the wrong symbol's results.`,
    };
  }

  return {
    retryPath: lookup.path,
    note: `"${symbolName}" is not declared in ${filePath}; resolved to ${formatSymbol(client, lookup.symbol).replace(/^• /, '')} and reporting from there.`,
  };
}

export const findDefinitionTool: ToolDefinition = {
  name: 'find_definition',
  description:
    'Find the definition of a symbol by name and kind in a file. Returns definitions for all matching symbols.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file',
      },
      symbol_name: {
        type: 'string',
        description: 'The name of the symbol',
      },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol (function, class, variable, method, etc.)',
      },
    },
    required: ['file_path', 'symbol_name'],
  },
  handler: async (args, client) => {
    const { file_path, symbol_name, symbol_kind } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
    };
    let searchPath = resolvePath(file_path);
    let redirect = '';

    let result = await client.findSymbolsByName(searchPath, symbol_name, symbol_kind);

    // Not declared here — find where it IS declared rather than dead-ending.
    if (result.matches.length === 0) {
      const resolved = await resolveElsewhere(
        client,
        'find_definition',
        file_path,
        symbol_name,
        symbol_kind
      );
      if ('text' in resolved) return textResult(resolved.text);
      searchPath = resolved.retryPath;
      redirect = `${resolved.note}\n\n`;
      result = await client.findSymbolsByName(searchPath, symbol_name, symbol_kind);
    }

    const { matches: symbolMatches, warning } = result;

    logger.debug(
      `[find_definition] Found ${symbolMatches.length} symbol matches for "${symbol_name}"\n`
    );

    if (symbolMatches.length === 0) {
      return textResult(
        `${redirect}No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${searchPath}. Please verify the symbol name and ensure the language server is properly configured.`
      );
    }

    const results = [];
    for (const match of symbolMatches) {
      logger.debug(
        `[find_definition] Processing match: ${match.name} (${client.symbolKindToString(match.kind)}) at ${match.position.line}:${match.position.character}\n`
      );
      try {
        const locations = await client.findDefinition(searchPath, match.position);
        logger.debug(`[find_definition] findDefinition returned ${locations.length} locations\n`);

        if (locations.length > 0) {
          const locationResults = formatLocations(locations);
          results.push(
            `Results for ${match.name} (${client.symbolKindToString(match.kind)}) at ${searchPath}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
          );
        } else {
          logger.debug(
            `[find_definition] No definition found for ${match.name} at position ${match.position.line}:${match.position.character}\n`
          );
        }
      } catch (error) {
        logger.error(`[find_definition] Error processing match: ${error}\n`);
      }
    }

    if (results.length === 0) {
      return textResult(
        withWarning(
          warning,
          `${redirect}Found ${symbolMatches.length} symbol(s) but no definitions could be retrieved. Please ensure the language server is properly configured.`
        )
      );
    }

    return textResult(withWarning(warning, redirect + results.join('\n\n')));
  },
};

export const findReferencesTool: ToolDefinition = {
  name: 'find_references',
  description:
    'Find all references to a symbol across the entire workspace. Returns references for all matching symbols.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file where the symbol is defined',
      },
      symbol_name: {
        type: 'string',
        description: 'The name of the symbol',
      },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol (function, class, variable, method, etc.)',
      },
      include_declaration: {
        type: 'boolean',
        description: 'Whether to include the declaration',
        default: true,
      },
    },
    required: ['file_path', 'symbol_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      symbol_name,
      symbol_kind,
      include_declaration = true,
    } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      include_declaration?: boolean;
    };
    let searchPath = resolvePath(file_path);
    let redirect = '';

    let result = await client.findSymbolsByName(searchPath, symbol_name, symbol_kind);

    // Not declared here — find where it IS declared rather than dead-ending.
    if (result.matches.length === 0) {
      const resolved = await resolveElsewhere(
        client,
        'find_references',
        file_path,
        symbol_name,
        symbol_kind
      );
      if ('text' in resolved) return textResult(resolved.text);
      searchPath = resolved.retryPath;
      redirect = `${resolved.note}\n\n`;
      result = await client.findSymbolsByName(searchPath, symbol_name, symbol_kind);
    }

    const { matches: symbolMatches, warning } = result;

    if (symbolMatches.length === 0) {
      return textResult(
        withWarning(
          warning,
          `${redirect}No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${searchPath}. Please verify the symbol name and ensure the language server is properly configured.`
        )
      );
    }

    const results = [];
    for (const match of symbolMatches) {
      try {
        const locations = await client.findReferences(
          searchPath,
          match.position,
          include_declaration
        );

        if (locations.length > 0) {
          const locationResults = formatLocations(locations);
          results.push(
            `Results for ${match.name} (${client.symbolKindToString(match.kind)}) at ${searchPath}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
          );
        }
      } catch (_error) {
        // Continue trying other symbols if one fails
      }
    }

    if (results.length === 0) {
      return textResult(
        withWarning(
          warning,
          `${redirect}Found ${symbolMatches.length} symbol(s) but no references could be retrieved. The index may still be warming ([NAV-002]) — repeat the query before concluding it is empty.`
        )
      );
    }

    return textResult(withWarning(warning, redirect + results.join('\n\n')));
  },
};

export const findImplementationTool: ToolDefinition = {
  name: 'find_implementation',
  description:
    'Find implementations of an interface or abstract method. Returns locations of all implementations.',
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
      const locations = await client.findImplementation(absolutePath, {
        line: line - 1,
        character: character - 1,
      });

      if (locations.length === 0) {
        return textResult(`No implementations found at ${file_path}:${line}:${character}`);
      }

      const locationList = formatLocations(locations);

      return textResult(`Found ${locations.length} implementation(s):\n\n${locationList}`);
    } catch (error) {
      return textResult(
        `Error finding implementations: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const navigationTools: ToolDefinition[] = [
  findDefinitionTool,
  findReferencesTool,
  findImplementationTool,
];
