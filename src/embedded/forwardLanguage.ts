/**
 * Forward completion, hover, and definition for an embedded field to the
 * language service of a scratch document in that language.
 *
 * The host buffer stays XML. Nested XML is not recolored there; this path is
 * how CSS, HTML, and XML fields still get the standalone language features.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { decodeXmlEntities } from '../parseSnXml';
import type { EmbeddedLanguage } from '../kinds/types';
import type { ScriptHit } from '../scriptHits';

const FORWARD_LANGUAGES = new Set<EmbeddedLanguage>(['css', 'html', 'xml']);

/**
 * True when the hit should use another language's providers instead of the
 * Registry script completer. JavaScript stays on the Registry path.
 */
export function forwardsToLanguageService(hit: ScriptHit): boolean {
  return FORWARD_LANGUAGES.has(hit.language);
}

/**
 * Completion items from the embedded language, with ranges shifted into the host.
 */
export async function forwardCompletion(
  host: vscode.TextDocument,
  position: vscode.Position,
  hit: ScriptHit
): Promise<vscode.CompletionItem[] | undefined> {
  const items = await withScratch(hit, host, position, async (scratch, scratchPos) => {
    const result = await vscode.commands.executeCommand<
      vscode.CompletionList | vscode.CompletionItem[]
    >('vscode.executeCompletionItemProvider', scratch.uri, scratchPos);
    const list = Array.isArray(result) ? result : result?.items;
    if (!list) {
      return undefined;
    }
    const canShift = host.getText().slice(hit.hostStart, hit.hostEnd) === hit.code;
    if (!canShift) {
      return list.map((item) => {
        const copy = item;
        copy.range = undefined;
        return copy;
      });
    }
    return list.map((item) => shiftCompletion(item, host, scratch, hit.hostStart));
  });
  if (!items || items.length === 0) {
    return undefined;
  }
  return items;
}

/**
 * Hover from the embedded language service.
 */
export async function forwardHover(
  host: vscode.TextDocument,
  position: vscode.Position,
  hit: ScriptHit
): Promise<vscode.Hover | undefined> {
  const hovers = await withScratch(hit, host, position, async (scratch, scratchPos) => {
    const result = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      scratch.uri,
      scratchPos
    );
    return result;
  });
  return hovers?.[0];
}

/**
 * Definition from the embedded language service.
 * Targets inside the scratch file are rewritten onto the host field.
 */
export async function forwardDefinition(
  host: vscode.TextDocument,
  position: vscode.Position,
  hit: ScriptHit
): Promise<vscode.DefinitionLink[] | undefined> {
  return withScratch(hit, host, position, async (scratch, scratchPos) => {
    const result = await vscode.commands.executeCommand<
      vscode.Location | vscode.Location[] | vscode.DefinitionLink[]
    >('vscode.executeDefinitionProvider', scratch.uri, scratchPos);
    if (!result) {
      return undefined;
    }
    const list = Array.isArray(result) ? result : [result];
    return list.map((entry) => toDefinitionLink(remapDefinition(entry, host, scratch, hit)));
  });
}

async function withScratch<T>(
  hit: ScriptHit,
  host: vscode.TextDocument,
  position: vscode.Position,
  body: (
    scratch: vscode.TextDocument,
    scratchPos: vscode.Position
  ) => Promise<T>
): Promise<T | undefined> {
  const cursor = decodedCursor(host.getText(), host.offsetAt(position), hit);
  const tempPath = path.join(
    os.tmpdir(),
    'servicenow-xml-forward',
    `forward-${Date.now()}-${Math.random().toString(36).slice(2)}${extensionFor(hit.language)}`
  );
  fs.mkdirSync(path.dirname(tempPath), { recursive: true });
  fs.writeFileSync(tempPath, hit.code, 'utf8');
  try {
    const scratch = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));
    await vscode.languages.setTextDocumentLanguage(scratch, languageId(hit.language));
    const scratchPos = scratch.positionAt(Math.min(cursor, scratch.getText().length));
    return await body(scratch, scratchPos);
  } catch {
    return undefined;
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // The language service may still have the file open. Leave it for the OS temp cleaner.
    }
  }
}

function decodedCursor(text: string, offset: number, hit: ScriptHit): number {
  const clamped = Math.min(Math.max(offset, hit.hostStart), hit.hostEnd);
  if (text.slice(hit.hostStart, hit.hostEnd) === hit.code) {
    return clamped - hit.hostStart;
  }
  const decoded = decodeXmlEntities(text.slice(hit.hostStart, clamped))
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '\n');
  return Math.min(decoded.length, hit.code.length);
}

function toDefinitionLink(
  entry: vscode.Location | vscode.DefinitionLink
): vscode.DefinitionLink {
  if (isLocation(entry)) {
    return {
      targetUri: entry.uri,
      targetRange: entry.range,
      targetSelectionRange: entry.range
    };
  }
  return entry;
}

function remapDefinition(
  entry: vscode.Location | vscode.DefinitionLink,
  host: vscode.TextDocument,
  scratch: vscode.TextDocument,
  hit: ScriptHit
): vscode.Location | vscode.DefinitionLink {
  if (!isSameUri(entryUri(entry), scratch.uri)) {
    return entry;
  }
  if (host.getText().slice(hit.hostStart, hit.hostEnd) !== hit.code) {
    return entry;
  }
  if (isLocation(entry)) {
    return new vscode.Location(host.uri, shiftRange(entry.range, host, scratch, hit.hostStart));
  }
  return {
    ...entry,
    targetUri: host.uri,
    targetRange: shiftRange(entry.targetRange, host, scratch, hit.hostStart),
    targetSelectionRange: entry.targetSelectionRange
      ? shiftRange(entry.targetSelectionRange, host, scratch, hit.hostStart)
      : undefined
  };
}

function shiftCompletion(
  item: vscode.CompletionItem,
  host: vscode.TextDocument,
  scratch: vscode.TextDocument,
  hostStart: number
): vscode.CompletionItem {
  if (!item.range) {
    return item;
  }
  if (item.range instanceof vscode.Range) {
    item.range = shiftRange(item.range, host, scratch, hostStart);
    return item;
  }
  item.range = {
    inserting: shiftRange(item.range.inserting, host, scratch, hostStart),
    replacing: shiftRange(item.range.replacing, host, scratch, hostStart)
  };
  return item;
}

function shiftRange(
  range: vscode.Range,
  host: vscode.TextDocument,
  scratch: vscode.TextDocument,
  hostStart: number
): vscode.Range {
  return new vscode.Range(
    host.positionAt(hostStart + scratch.offsetAt(range.start)),
    host.positionAt(hostStart + scratch.offsetAt(range.end))
  );
}

function entryUri(entry: vscode.Location | vscode.DefinitionLink): vscode.Uri {
  return isLocation(entry) ? entry.uri : entry.targetUri;
}

function isLocation(
  entry: vscode.Location | vscode.DefinitionLink
): entry is vscode.Location {
  return 'uri' in entry;
}

function isSameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

function languageId(language: EmbeddedLanguage): string {
  return language === 'javascript' ? 'javascript' : language;
}

function extensionFor(language: EmbeddedLanguage): string {
  switch (language) {
    case 'javascript':
      return '.js';
    case 'json':
      return '.json';
    case 'css':
      return '.css';
    case 'html':
      return '.html';
    case 'xml':
      return '.xml';
  }
}
