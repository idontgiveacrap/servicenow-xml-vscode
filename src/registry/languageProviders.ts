/**
 * VS Code language providers backed by the Registry (completion, hover,
 * definition, references, document symbols).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { getWorkspaceRegistryService } from './vscodeAdapter';
import { resolveScriptIncludeReference } from './lazyParse';

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
          const line = document.lineAt(position.line).text;
          const prefix = line.slice(0, position.character);
          // Inside a script-ish region: after `new ` suggest Glide* / SI names.
          const newMatch = /new\s+([A-Za-z_$][\w$]*)$/.exec(prefix);
          if (newMatch) {
            const partial = newMatch[1].toLowerCase();
            const items: vscode.CompletionItem[] = [];
            for (const symbol of [
              ...service.registry.listPlatformGlobals('server'),
              ...service.registry.listWorkspaceDeclarations()
            ]) {
              if (!symbol.name.toLowerCase().startsWith(partial)) {
                continue;
              }
              const item = new vscode.CompletionItem(
                symbol.name,
                symbol.kind === 'ScriptInclude' || symbol.kind === 'UiScript'
                  ? vscode.CompletionItemKind.Class
                  : vscode.CompletionItemKind.Constructor
              );
              item.detail = symbol.kind;
              if (symbol.documentation) {
                item.documentation = symbol.documentation;
              }
              items.push(item);
              if (items.length >= 50) {
                break;
              }
            }
            return items;
          }

          // After `new GlideRecord('` suggest table names.
          const tableMatch = /new\s+GlideRecord(?:Secure)?\s*\(\s*['"]([^'"]*)$/.exec(
            prefix
          );
          if (tableMatch) {
            const partial = tableMatch[1].toLowerCase();
            const items: vscode.CompletionItem[] = [];
            for (const table of service.registry.listTables()) {
              if (partial && !table.name.toLowerCase().startsWith(partial)) {
                continue;
              }
              const item = new vscode.CompletionItem(
                table.name,
                vscode.CompletionItemKind.Struct
              );
              item.detail = table.label ?? 'table';
              items.push(item);
              if (items.length >= 50) {
                break;
              }
            }
            return items;
          }

          return undefined;
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
          return `**${symbol.name}**${scope} — \`${symbol.kind}\``;
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
        // Lazy-resolve SI methods so the dependency graph gets an edge.
        resolveScriptIncludeReference(service.registry, word, (uri) => {
          try {
            const parsed = vscode.Uri.parse(uri);
            if (parsed.scheme === 'file') {
              return fs.readFileSync(parsed.fsPath, 'utf8');
            }
          } catch {
            return undefined;
          }
          return undefined;
        });

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
