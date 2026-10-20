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

/** Command id shared by every code lens. */
export const CODELENS_COMMAND = 'servicenowXml.codelens.openUrl';

/** Register the ServiceNow URL CodeLens provider and its command. */
export function registerCodeLens(context: vscode.ExtensionContext): void {
  const provider = new ServiceNowCodeLensProvider();
  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider(XML_SELECTOR, provider),
    vscode.commands.registerCommand(
      CODELENS_COMMAND,
      handleOpenUrl
    )
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
 */
async function handleOpenUrl(url: string, baseUrl: string): Promise<void> {
  const target = baseUrl ? joinBaseUrl(baseUrl, url) : url;
  if (isAbsoluteUrl(target)) {
    const ok = await vscode.env.openExternal(vscode.Uri.parse(target));
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

    if (withSysId.length === 0) {
      return [];
    }

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

    return lenses;
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
