/**
 * VS Code language providers backed by the Registry (completion, hover,
 * definition, references, document symbols).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { decodeXmlEntities } from './parseSnXml';
import { scriptAt, ScriptHit } from './scriptHits';
import { resolveScriptIncludeReference } from './registry/lazyParse';
import {
  CompletionCandidate,
  CompletionKind,
  scriptCompletions
} from './registry/scriptCompletion';
import { symbolId } from './registry/types';
import { getWorkspaceRegistryService } from './registry/vscodeAdapter';

const XML_SELECTOR: vscode.DocumentSelector = { language: 'xml' };

/**
 * Register Registry-backed IntelliSense providers for ServiceNow XML exports.
 */
export function registerRegistryLanguageProviders(
  context: vscode.ExtensionContext
): void {
  const service = getWorkspaceRegistryService();

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      XML_SELECTOR,
      {
        provideCompletionItems(document, position) {
          const text = document.getText();
          const offset = document.offsetAt(position);
          const hit = scriptAt(text, offset, { hostPath: document.uri.fsPath });
          if (!hit || (hit.role !== 'scriptField' && hit.role !== 'jsonString')) {
            return undefined;
          }
          const candidates = scriptCompletions({
            code: hit.code,
            cursor: cursorInScript(text, offset, hit),
            profile: hit.profile,
            registry: service.registry,
            ensureTableFields: (table) => {
              service.getFieldIndex()?.ensureTableFields(table);
            },
            readFile: readWorkspaceFile
          });
          if (candidates.length === 0) {
            return undefined;
          }
          return candidates.map(toCompletionItem);
        }
      },
      '.',
      "'",
      '"'
    ),

    vscode.languages.registerHoverProvider(XML_SELECTOR, {
      provideHover(document, position) {
        const wordRange = document.getWordRangeAtPosition(
          position,
          /[A-Za-z_$][\w$]*/
        );
        if (!wordRange) {
          return undefined;
        }
        const word = document.getText(wordRange);
        const matches = service.registry.lookup(word);
        if (matches.length === 0) {
          const table = service.registry.getTable(word);
          if (table) {
            return new vscode.Hover(
              `**${table.name}**${table.label ? ` — ${table.label}` : ''}\n\n_Registry table_`
            );
          }
          return undefined;
        }
        const lines = matches.slice(0, 5).map((symbol) => {
          const scope = symbol.scope ? ` (\`${symbol.scope}\`)` : '';
          const doc = symbol.documentation ? `\n\n${symbol.documentation}` : '';
          return `**${symbol.name}**${scope} — \`${symbol.kind}\`${doc}`;
        });
        return new vscode.Hover(lines.join('\n\n'));
      }
    }),

    vscode.languages.registerDefinitionProvider(XML_SELECTOR, {
      provideDefinition(document, position) {
        const wordRange = document.getWordRangeAtPosition(
          position,
          /[A-Za-z_$][\w$]*/
        );
        if (!wordRange) {
          return undefined;
        }
        const word = document.getText(wordRange);
        const matches = service.registry
          .lookup(word)
          .filter(
            (s) =>
              (s.kind === 'ScriptInclude' ||
                s.kind === 'UiScript' ||
                s.kind === 'Record') &&
              s.uri
          );
        const locations: vscode.Location[] = [];
        for (const match of matches) {
          try {
            const uri = vscode.Uri.parse(match.uri!);
            if (match.kind === 'Record' && uri.toString() === document.uri.toString()) {
              const pos = document.positionAt(match.startOffset);
              locations.push(new vscode.Location(uri, pos));
            } else {
              locations.push(new vscode.Location(uri, new vscode.Position(0, 0)));
            }
          } catch {
            // skip bad uri
          }
        }
        return locations.length > 0 ? locations : undefined;
      }
    }),

    vscode.languages.registerReferenceProvider(XML_SELECTOR, {
      provideReferences(document, position) {
        const wordRange = document.getWordRangeAtPosition(
          position,
          /[A-Za-z_$][\w$]*/
        );
        if (!wordRange) {
          return undefined;
        }
        const word = document.getText(wordRange);
        resolveScriptIncludeReference(service.registry, word, readWorkspaceFile);
        for (const symbol of service.registry.lookup(word)) {
          if (symbol.kind !== 'ScriptInclude' && symbol.kind !== 'UiScript') {
            continue;
          }
          service.registry.addEdge({
            fromId: document.uri.toString(),
            toId: symbolId(symbol),
            kind: 'references'
          });
        }

        const locations: vscode.Location[] = [];
        // Same-document textual references (lightweight).
        const text = document.getText();
        const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          locations.push(
            new vscode.Location(document.uri, document.positionAt(match.index))
          );
        }
        return locations;
      }
    }),

    vscode.languages.registerDocumentSymbolProvider(XML_SELECTOR, {
      provideDocumentSymbols(document) {
        const records = service.registry
          .byUriString(document.uri.toString())
          .filter((s) => s.kind === 'Record');
        return records.map((record) => {
          if (record.kind !== 'Record') {
            return undefined;
          }
          const pos = document.positionAt(record.startOffset);
          return new vscode.DocumentSymbol(
            record.displayName,
            record.table,
            vscode.SymbolKind.Object,
            new vscode.Range(pos, pos),
            new vscode.Range(pos, pos)
          );
        }).filter((s): s is vscode.DocumentSymbol => !!s);
      }
    })
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Offset of the cursor inside the decoded script body.
 */
function cursorInScript(text: string, offset: number, hit: ScriptHit): number {
  const clamped = Math.min(Math.max(offset, hit.hostStart), hit.hostEnd);
  if (text.slice(hit.hostStart, hit.hostEnd) === hit.code) {
    return clamped - hit.hostStart;
  }
  const decoded = decodeXmlEntities(text.slice(hit.hostStart, clamped)).replace(
    /\r\n/g,
    '\n'
  );
  return Math.min(decoded.length, hit.code.length);
}

function readWorkspaceFile(uri: string): string | undefined {
  try {
    const parsed = vscode.Uri.parse(uri);
    if (parsed.scheme === 'file') {
      return fs.readFileSync(parsed.fsPath, 'utf8');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toCompletionItem(candidate: CompletionCandidate): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    candidate.label,
    completionKind(candidate.kind)
  );
  item.detail = candidate.detail;
  if (candidate.documentation) {
    item.documentation = candidate.documentation;
  }
  return item;
}

function completionKind(kind: CompletionKind): vscode.CompletionItemKind {
  switch (kind) {
    case 'class':
      return vscode.CompletionItemKind.Class;
    case 'function':
      return vscode.CompletionItemKind.Function;
    case 'field':
      return vscode.CompletionItemKind.Field;
    case 'method':
      return vscode.CompletionItemKind.Method;
    case 'table':
      return vscode.CompletionItemKind.Struct;
    default:
      return vscode.CompletionItemKind.Constructor;
  }
}
