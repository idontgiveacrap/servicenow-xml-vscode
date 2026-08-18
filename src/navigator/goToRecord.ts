import * as vscode from 'vscode';
import { CatalogRecord, RecordCatalog } from './catalog';

/**
 * Open a catalog record URI, falling back when the file exceeds extension sync limits.
 */
async function openCatalogRecordUri(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.window.showTextDocument(uri);
  } catch (error) {
    await vscode.commands.executeCommand('vscode.open', uri);
    const detail = error instanceof Error ? error.message : String(error);
    if (/size limit|synchronized with extensions/i.test(detail)) {
      void vscode.window.showWarningMessage(
        'This record XML is too large for extension sync (Cursor/VS Code ~50MB limit). Opened without lint.'
      );
    }
  }
}

/**
 * Register Go-to-record QuickPick and a lazy workspace-symbol provider.
 */
export function registerGoToRecord(
  context: vscode.ExtensionContext,
  catalog: RecordCatalog
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('servicenowXml.goToRecord', async () => {
      if (!catalog.isEnabled()) {
        const enable = 'Enable navigator';
        const choice = await vscode.window.showInformationMessage(
          'ServiceNow Records navigator is disabled. Enable it to search records?',
          enable
        );
        if (choice === enable) {
          await vscode.workspace
            .getConfiguration('servicenowXml')
            .update('navigator.enable', true, vscode.ConfigurationTarget.Workspace);
        } else {
          return;
        }
      }

      const ok = await catalog.ensure({ showProgress: true });
      if (!ok) {
        return;
      }

      const records = catalog.getAllRecords();
      const picker = vscode.window.createQuickPick<RecordQuickPickItem>();
      const resultLimit = 200;
      picker.placeholder = 'Go to ServiceNow record (name, table, or path)';
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;

      /** Filter and cap materialized QuickPick items for responsive large repos. */
      const updateItems = (value: string) => {
        const query = value.trim().toLowerCase();
        const matched = query
          ? records.filter((record) => matchesQuery(record, query))
          : records;
        picker.items = matched.slice(0, resultLimit).map(toQuickPick);
        picker.title =
          matched.length > resultLimit
            ? `ServiceNow Records — showing ${resultLimit} of ${matched.length}`
            : `ServiceNow Records — ${matched.length}`;
      };

      const disposables = [
        picker.onDidChangeValue(updateItems),
        picker.onDidAccept(() => {
          const selected = picker.selectedItems[0];
          if (selected) {
            void openCatalogRecordUri(selected.record.uri);
            picker.hide();
          }
        }),
        picker.onDidHide(() => {
          for (const disposable of disposables) {
            disposable.dispose();
          }
          picker.dispose();
        })
      ];
      updateItems('');
      picker.show();
    }),

    vscode.languages.registerWorkspaceSymbolProvider({
      async provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken
      ): Promise<vscode.SymbolInformation[]> {
        // Do not index merely because the workspace-symbol picker opened.
        const q = query.trim().toLowerCase();
        if (
          q.length < 3 ||
          token.isCancellationRequested ||
          !catalog.isEnabled()
        ) {
          return [];
        }
        await catalog.ensure({ showProgress: false });
        if (token.isCancellationRequested) {
          return [];
        }
        const resultLimit = 200;
        const records = catalog.getAllRecords();
        const matched: CatalogRecord[] = [];
        for (const r of records) {
          if (matchesQuery(r, q)) {
            matched.push(r);
            if (matched.length >= resultLimit) {
              break;
            }
          }
        }

        return matched.map(
          (r) =>
            new vscode.SymbolInformation(
              r.displayName,
              vscode.SymbolKind.File,
              r.table,
              new vscode.Location(r.uri, new vscode.Position(0, 0))
            )
        );
      }
    })
  );
}

interface RecordQuickPickItem extends vscode.QuickPickItem {
  record: CatalogRecord;
}

function toQuickPick(record: CatalogRecord): RecordQuickPickItem {
  return {
    label: record.displayName,
    description: record.table,
    detail: record.relativePath,
    record
  };
}

/**
 * Match a catalog record against a lowercased query (name, table, api_name, sys_id, path).
 */
export function matchesQuery(record: CatalogRecord, q: string): boolean {
  if (record.displayName.toLowerCase().includes(q)) {
    return true;
  }
  if (record.table.toLowerCase().includes(q)) {
    return true;
  }
  if (`${record.table}.${record.displayName}`.toLowerCase().includes(q)) {
    return true;
  }
  if (record.apiName?.toLowerCase().includes(q)) {
    return true;
  }
  if (record.sysId?.toLowerCase().includes(q)) {
    return true;
  }
  if (record.relativePath.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}
