import type { LSPClient } from '../lsp-client.js';
import type { SymbolInformation } from '../types.js';
import { uriToPath } from '../utils.js';

/**
 * Shared workspace-symbol handling for the name-based tools.
 *
 * `workspace/symbol` matches LEAF names by subsequence and reports the container
 * separately, which has two consequences every caller has to deal with the same
 * way: a qualified `Nest.Name` query never matches as written, and an unqualified
 * one returns enormous incidental result sets (a bare "URI" matched 91,574
 * symbols in a ~460-package workspace). Doing this in one place keeps
 * find_workspace_symbols, find_references and find_definition from disagreeing
 * about what a name resolves to.
 */

/** Results shown before truncating. The suppressed count is always reported. */
export const WORKSPACE_SYMBOL_LIMIT = 50;

/** `Container.Name` when the server gave us a container, else the bare name. */
export function qualifiedName(symbol: { name: string; containerName?: string }): string {
  return symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
}

/**
 * Rank a match against the leaf the user asked for. Subsequence matching buries
 * the exact hit among thousands of incidental ones unless the client ranks.
 */
export function matchRank(name: string, leaf: string): number {
  if (name === leaf) return 0;
  if (name.toLowerCase() === leaf.toLowerCase()) return 1;
  if (name.startsWith(leaf)) return 2;
  if (name.toLowerCase().includes(leaf.toLowerCase())) return 3;
  return 4;
}

export interface FilteredSymbols {
  matches: SymbolInformation[];
  leaf: string;
  container?: string;
  total: number;
  checkoutsHidden: number;
  generatedHidden: number;
}

/**
 * Split a possibly-qualified query, ask the server for the leaf, then filter and
 * rank what comes back. Every count that shaped the result is returned so the
 * caller can report it — a short list must never be mistaken for a small result
 * set, which is how a still-warming index gets misread as a broken one.
 */
export async function findSymbolsInWorkspace(
  client: LSPClient,
  query: string
): Promise<FilteredSymbols> {
  const parts = query.split('.').filter(Boolean);
  const leaf = parts[parts.length - 1] ?? query;
  const container = parts.length > 1 ? parts[parts.length - 2] : undefined;

  const symbols = await client.workspaceSymbol(leaf);
  const total = symbols.length;

  // Results on read-only dependency copies are never actionable: editing one
  // changes a throwaway artifact that the next resolve discards. Swift units are
  // filtered at index-build time, but C symbols reach us through Clang module
  // units, which carry header paths inside checkouts.
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

  return { matches, leaf, container, total, checkoutsHidden, generatedHidden };
}

/** Human-readable summary of what was filtered away, for appending to output. */
export function filterNotes(filtered: FilteredSymbols, shownCount?: number): string {
  const notes: string[] = [`${filtered.total} raw match(es) from the server`];
  if (filtered.checkoutsHidden) {
    notes.push(`${filtered.checkoutsHidden} on read-only checkout paths hidden`);
  }
  if (filtered.generatedHidden) notes.push(`${filtered.generatedHidden} compiler-generated hidden`);
  if (filtered.container) notes.push(`filtered to container "${filtered.container}"`);
  if (shownCount !== undefined && filtered.matches.length > shownCount) {
    notes.push(`showing top ${shownCount} of ${filtered.matches.length} by relevance`);
  }
  return notes.join('; ');
}

export type DeclarationLookup =
  | { outcome: 'resolved'; path: string; symbol: SymbolInformation; filtered: FilteredSymbols }
  | { outcome: 'ambiguous'; candidates: SymbolInformation[]; filtered: FilteredSymbols }
  | { outcome: 'not-found'; filtered: FilteredSymbols };

/**
 * Locate the file a symbol is DECLARED in.
 *
 * The name-based tools resolve a symbol against the document symbols of the file
 * they are given, so passing a file that merely uses the symbol yields "no
 * symbols found" — which reads like an index failure and is not one. This lets
 * those tools recover by finding the declaration themselves.
 *
 * Ambiguity is reported, never guessed: when several equally-good candidates
 * share the name, answering about one of them silently would attribute another
 * symbol's references to the one that was asked about.
 */
export async function findDeclaringFile(
  client: LSPClient,
  symbolName: string,
  symbolKind?: string
): Promise<DeclarationLookup> {
  const filtered = await findSymbolsInWorkspace(client, symbolName);

  let candidates = filtered.matches;
  if (symbolKind) {
    const ofKind = candidates.filter(
      (sym) => client.symbolKindToString(sym.kind).toLowerCase() === symbolKind.toLowerCase()
    );
    // Only narrow by kind when it leaves something; an unrecognised kind string
    // should not turn a findable symbol into a missing one.
    if (ofKind.length > 0) candidates = ofKind;
  }

  if (candidates.length === 0) return { outcome: 'not-found', filtered };

  // Consider only the best rank: an exact name match and an incidental
  // subsequence match are not comparable candidates.
  const bestRank = matchRank(candidates[0]?.name ?? '', filtered.leaf);
  const best = candidates.filter((sym) => matchRank(sym.name, filtered.leaf) === bestRank);

  // Several entries for one declaration (a type and its extensions) are the same
  // answer; distinct files are a genuine ambiguity.
  const distinctFiles = new Set(best.map((sym) => uriToPath(sym.location.uri)));
  if (distinctFiles.size > 1) return { outcome: 'ambiguous', candidates: best, filtered };

  const chosen = best[0];
  if (!chosen) return { outcome: 'not-found', filtered };
  return { outcome: 'resolved', path: uriToPath(chosen.location.uri), symbol: chosen, filtered };
}

/** One-line rendering of a workspace symbol, used in every tool's output. */
export function formatSymbol(client: LSPClient, symbol: SymbolInformation): string {
  const filePath = uriToPath(symbol.location.uri);
  const { start } = symbol.location.range;
  return `• ${qualifiedName(symbol)} (${client.symbolKindToString(symbol.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}`;
}
