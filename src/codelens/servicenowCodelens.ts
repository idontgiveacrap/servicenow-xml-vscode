/**
 * CodeLens provider that surfaces ServiceNow record URLs at the top of each
 * export file.
 *
 * When `servicenowXml.instanceBaseUrl` is set, the links open directly in a
 * browser.  When it is empty, the relative path is copied to the clipboard so
 * the user can paste it into an address bar.
 */

import * as vscode from 'vscode';
import { extractRecordIdentities } from '../navigator/recordName';
import { looksLikeSnExportDocument } from '../snDocumentShape';
import { extractXmlReferences } from '../registry/xmlReferences';
import { getWorkspaceRegistryService } from '../registry/vscodeAdapter';
import {
  buildRecordUrls,
  joinBaseUrl,
  isAbsoluteUrl,
  RecordUrls,
  URL_LABELS,
  URL_TYPES,
  OPEN_EMOJI,
  COPY_EMOJI
} from './recordUrls';

const XML_SELECTOR: vscode.DocumentSelector = { language: 'xml' };

/** Command id shared by the instance-URL lenses. */
export const CODELENS_COMMAND = 'servicenowXml.codelens.openUrl';

/** Opens the workspace file that defines a referenced sys_id. */
export const CODELENS_OPEN_RECORD = 'servicenowXml.codelens.openRecord';

/** Register the ServiceNow URL CodeLens provider and its command. */
export function registerCodeLens(context: vscode.ExtensionContext): void {
  const provider = new ServiceNowCodeLensProvider();
  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider(XML_SELECTOR, provider),
    vscode.commands.registerCommand(CODELENS_COMMAND, handleOpenUrl),
    vscode.commands.registerCommand(CODELENS_OPEN_RECORD, handleOpenRecord)
  );

  // Refresh lenses when the settings that affect them change, so the title
  // flips between open-in-browser and copy-to-clipboard without a reopen.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('servicenowXml.codelens.enable') ||
        e.affectsConfiguration('servicenowXml.instanceBaseUrl')
      ) {
        provider.refresh();
      }
    })
  );
}

/**
 * Handle the single command that backs every code lens: open an absolute URL
 * in the browser, or copy a relative path to the clipboard when no base URL
 * is configured.
 *
 * Pass the raw string to `openExternal`. A `Uri` is opened via
 * `encodeURI(uri.toString(true))`, which percent-encodes an already-encoded
 * query (`%3F` → `%253F`). `nav_to.do?uri=table.do?sys_id=` depends on that
 * nested question mark surviving a single decode.
 */
async function handleOpenUrl(url: string, baseUrl: string): Promise<void> {
  const target = baseUrl ? joinBaseUrl(baseUrl, url) : url;
  if (isAbsoluteUrl(target)) {
    const ok = await vscode.env.openExternal(target as unknown as vscode.Uri);
    if (!ok) {
      void vscode.window.showWarningMessage(
        `ServiceNow XML: could not open ${target}. Copied to clipboard instead.`
      );
      await vscode.env.clipboard.writeText(target);
    }
  } else {
    await vscode.env.clipboard.writeText(target);
    const label = target.length > 60 ? target.slice(0, 57) + '…' : target;
    void vscode.window.showInformationMessage(`Copied to clipboard: ${label}`);
  }
}

/**
 * Open the export file that defines a referenced record.
 * No arguments means the id was not in the loaded registry cache.
 */
async function handleOpenRecord(uri?: string, startOffset?: number): Promise<void> {
  if (!uri) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const editor = await vscode.window.showTextDocument(doc);
  const pos = doc.positionAt(startOffset ?? 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

/** Unresolved lens whose title is filled in by `resolveCodeLens`. */
interface ReferenceCodeLens extends vscode.CodeLens {
  refSysId: string;
}

/** A record identity with the fields the lens builder needs. */
interface LensIdentity {
  table: string;
  sysId?: string;
  displayName: string;
  startOffset: number;
}

/**
 * CodeLens provider for ServiceNow export XML files.
 *
 * Emits one lens per URL variant (Studio, form, JSON, XML) for every record
 * row that carries a sys_id.  Multi-row exports therefore get a group per
 * row at that row's start line.
 */
export class ServiceNowCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (!isEnabled()) {
      return [];
    }
    if (!looksLikeSnExportDocument(document)) {
      return [];
    }

    const text = document.getText();
    const identities = extractRecordIdentities(text, document.uri.fsPath);
    const withSysId = identities.filter(
      (identity) => !!identity.sysId
    ) as LensIdentity[];

    const baseUrl = getBaseUrl();
    const isSingle = withSysId.length === 1;
    const lenses: vscode.CodeLens[] = [];

    for (const identity of withSysId) {
      const startLine = document.positionAt(identity.startOffset).line;
      const urls = buildRecordUrls(identity.table, identity.sysId!);

      for (const urlType of URL_TYPES) {
        const url = urls[urlType];
        const range = new vscode.Range(startLine, 0, startLine, 0);
        lenses.push(
          new vscode.CodeLens(range, buildCommand(urlType, url, baseUrl, identity, isSingle))
        );
      }
    }

    for (const edge of extractXmlReferences(text, {
      uri: document.uri.toString(),
      relativePath: document.uri.fsPath
    })) {
      const start = document.positionAt(edge.startOffset);
      const end = document.positionAt(edge.startOffset + edge.toSysId.length);
      const lens = new vscode.CodeLens(new vscode.Range(start, end)) as ReferenceCodeLens;
      lens.refSysId = edge.toSysId;
      lenses.push(lens);
    }

    return lenses;
  }

  /**
   * Fill a reference lens from the registry cache. Does not scan the workspace.
   */
  resolveCodeLens(
    lens: vscode.CodeLens,
    _token: vscode.CancellationToken
  ): vscode.CodeLens {
    const ref = lens as ReferenceCodeLens;
    if (!ref.refSysId || ref.command) {
      return lens;
    }
    const record = getWorkspaceRegistryService().registry.lookupBySysId(ref.refSysId);
    if (!record?.uri) {
      ref.command = {
        title: ref.refSysId,
        command: CODELENS_OPEN_RECORD,
        arguments: []
      };
      return ref;
    }
    const where = record.relativePath ?? record.uri;
    ref.command = {
      title: `${record.displayName} — ${where}`,
      tooltip: where,
      command: CODELENS_OPEN_RECORD,
      arguments: [record.uri, record.startOffset]
    };
    return ref;
  }

  /** Fire the change event so VS Code re-runs `provideCodeLenses`. */
  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}

/** Read `servicenowXml.codelens.enable` (default true). */
function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('servicenowXml')
    .get<boolean>('codelens.enable', true);
}

/** Read `servicenowXml.instanceBaseUrl` (default empty). */
function getBaseUrl(): string {
  return (
    vscode.workspace
      .getConfiguration('servicenowXml')
      .get<string>('instanceBaseUrl', '') ?? ''
  );
}

/**
 * Build a CodeLens command for one URL variant.
 *
 * The title toggles between a globe (open in browser) and a clipboard (copy)
 * depending on whether a base URL is configured.  The tooltip carries the full
 * URL so users can preview it before clicking.
 */
function buildCommand(
  urlType: keyof RecordUrls,
  url: string,
  baseUrl: string,
  identity: LensIdentity,
  isSingle: boolean
): vscode.Command {
  const label = URL_LABELS[urlType];
  const hasBaseUrl = Boolean(baseUrl);
  const icon = hasBaseUrl ? OPEN_EMOJI : COPY_EMOJI;
  const title = isSingle
    ? `${icon} ${label} URL`
    : `${icon} ${label} (${identity.displayName}) URL`;
  const target = hasBaseUrl ? joinBaseUrl(baseUrl, url) : url;
  const tooltip = hasBaseUrl
    ? ` ${label} in browser:\n${target}`
    : `Copy ${label} URL:\n${url}`;
  return {
    title,
    tooltip,
    command: CODELENS_COMMAND,
    arguments: [url, baseUrl]
  };
}
