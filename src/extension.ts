import * as vscode from 'vscode';
import { DiagnosticsController } from './diagnostics';
import { KindStatusBar } from './statusBar';
import {
  CatalogRecord,
  NavigatorSortBy,
  RecordCatalog
} from './navigator/catalog';
import {
  getRecordUriFromTreeElement,
  RecordsDragAndDropController,
  RecordsTreeProvider,
  TreeNode
} from './navigator/tree';
import { registerGoToRecord } from './navigator/goToRecord';
import { ActiveRecordSync } from './navigator/activeRecord';
import {
  GitStatusTracker,
  RecordsGitDecorationProvider
} from './navigator/gitStatus';
import { SnWorkspaceGate } from './snWorkspaceGate';
import {
  cursorHelpersNeedReload,
  installCursorHelpers,
  isCursorHost,
  registerCursorHelpersDisposal,
  runRepoIndexer,
  suggestReloadAfterCursorHelpers
} from './cursorHelpers';
import { registerJsonStringEditor } from './jsonStringEditor';
import { registerEmbeddedFormatter } from './formatEmbedded';
import { looksLikeSnExportDocument } from './snDocumentShape';
import { extractRecordIdentities } from './navigator/recordName';
import { ScriptDeclarationIndex } from './scriptDeclarationIndex';

const SORT_BY_PICKS: Array<{
  label: string;
  description: string;
  value: NavigatorSortBy;
}> = [
  {
    label: 'Most opened',
    description: 'Open count (sum per table)',
    value: 'mostOpened'
  },
  {
    label: 'Recently opened',
    description: 'Last open time',
    value: 'recentlyOpened'
  },
  {
    label: 'Recently updated',
    description: 'File modification time',
    value: 'recentlyUpdated'
  },
  {
    label: 'sys_mod_count',
    description: 'ServiceNow update count',
    value: 'sysModCount'
  },
  {
    label: 'Name',
    description: 'Alphabetical',
    value: 'name'
  }
];

/**
 * Activate ServiceNow XML diagnostics and the optional Records navigator.
 * Syntax coloring is contributed via TextMate injection (no runtime hook needed).
 * The tree provider is registered first so the Records view never sits without a provider.
 * Catalog indexing starts when the gate passes and navigator.enable is true (eager),
 * and also when the Records view becomes visible.
 * Lint and the Records view stay gated until `{sys_id}/sys_app_{sys_id}.xml` is found
 * (or `enabledForAllWindows` bypasses the gate).
 */
export function activate(context: vscode.ExtensionContext): void {
  const gate = new SnWorkspaceGate(context.workspaceState);
  context.subscriptions.push(gate);

  registerJsonStringEditor(context);
  registerEmbeddedFormatter(context, (document) => gate.isValidationAllowed(document));

  // Register the Records tree before any heavier work so the activity-bar view
  // never shows "no data provider" if a later step fails or activation is delayed.
  const catalog = new RecordCatalog(context.workspaceState);
  const declarationIndex = new ScriptDeclarationIndex(context.workspaceState);
  declarationIndex.configure({
    isActive: () =>
      gate.isLintActive() &&
      vscode.workspace
        .getConfiguration('servicenowXml')
        .get<boolean>('enable', true) &&
      vscode.workspace
        .getConfiguration('servicenowXml')
        .get<boolean>('lintJavaScript', true),
    getWorkspaceAppSysId: () => gate.getWorkspaceAppSysId(),
    getWorkspaceAppScope: () => gate.getWorkspaceAppScope()
  });
  const treeProvider = new RecordsTreeProvider(catalog);
  const treeView = vscode.window.createTreeView<TreeNode>('servicenowXml.records', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new RecordsDragAndDropController(treeProvider)
  });
  context.subscriptions.push(
    catalog,
    declarationIndex,
    treeProvider,
    treeView,
    treeView.onDidChangeVisibility((e) => {
      treeProvider.setViewVisible(e.visible);
    })
  );
  if (treeView.visible) {
    treeProvider.setViewVisible(true);
  }
  syncRecordsFilterUi(treeView, treeProvider);

  // Follows the active editor. Registered here (not with the other commands) so
  // clicking a record still opens it even if later activation steps fail.
  const activeRecordSync = new ActiveRecordSync(treeView, treeProvider, catalog);
  context.subscriptions.push(
    activeRecordSync,
    vscode.commands.registerCommand(
      'servicenowXml.navigator.openRecord',
      /**
       * Open a navigator record at its row. Re-extract from the current document
       * so unsaved edits above the row do not make the indexed offset stale.
       */
      async (record: CatalogRecord) => {
        try {
          const document = await vscode.workspace.openTextDocument(record.uri);
          const candidates = extractRecordIdentities(
            document.getText(),
            record.uri.fsPath
          ).filter((identity) => {
            if (identity.table !== record.table) {
              return false;
            }
            if (record.sysId) {
              return identity.sysId === record.sysId;
            }
            return (
              identity.displayName === record.displayName &&
              identity.apiName === record.apiName &&
              identity.action === record.action
            );
          });
          candidates.sort(
            (a, b) =>
              Math.abs(a.startOffset - record.startOffset) -
              Math.abs(b.startOffset - record.startOffset)
          );
          const offset = candidates[0]?.startOffset ?? record.startOffset;
          const position = document.positionAt(offset);
          await vscode.window.showTextDocument(document, {
            selection: new vscode.Range(position, position)
          });
        } catch (error) {
          // Cursor/VS Code refuse to sync documents above ~50MB to the extension
          // host. Open via the built-in command so the editor still appears.
          await vscode.commands.executeCommand('vscode.open', record.uri);
          const detail = error instanceof Error ? error.message : String(error);
          if (/size limit|synchronized with extensions/i.test(detail)) {
            void vscode.window.showWarningMessage(
              'This record XML is too large for extension sync (Cursor/VS Code ~50MB limit). Opened without jump-to-row or lint.'
            );
          } else {
            void vscode.window.showErrorMessage(
              `Failed to open record: ${detail}`
            );
          }
        }
      }
    )
  );

  // Table folders are groupings rather than directories, so their Git state has
  // to be rolled up from the record files they contain.
  const gitStatus = new GitStatusTracker();
  const gitDecorations = new RecordsGitDecorationProvider(catalog, gitStatus);
  context.subscriptions.push(
    gitStatus,
    gitDecorations,
    vscode.window.registerFileDecorationProvider(gitDecorations)
  );

  // Overlap indexing with view appearance when cache/gate already says SN workspace.
  maybeStartCatalogIndex(catalog, treeProvider, gate);

  try {
    activateDiagnosticsAndCommands(
      context,
      catalog,
      treeProvider,
      treeView,
      gate,
      declarationIndex
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[servicenow-xml] activation failed after tree registration:', error);
    void vscode.window.showErrorMessage(
      `ServiceNow XML activated the Records view, but other features failed: ${message}`
    );
  }

  maybeStartDeclarationIndex(declarationIndex);

  // Cursor-only helpers: fire-and-forget after core features. Missing Python must
  // not delay or break lint/navigator (installCursorHelpers never throws).
  if (isCursorHost()) {
    void installCursorHelpers(context)
      .then((result) => {
        registerCursorHelpersDisposal(context, result.pluginPath);
        if (result.messages.length > 0) {
          console.log(
            '[servicenow-xml] cursor helpers:',
            result.messages.join(' | ')
          );
        }
        if (cursorHelpersNeedReload(result)) {
          void suggestReloadAfterCursorHelpers('Cursor helpers installed.');
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[servicenow-xml] cursor helpers failed (non-fatal):', message);
      });
  }
}

/**
 * Start catalog indexing when the navigator is enabled and the SN workspace gate
 * (or enabledForAllWindows) allows it — without waiting for the view to open.
 */
function maybeStartCatalogIndex(
  catalog: RecordCatalog,
  treeProvider: RecordsTreeProvider,
  gate: SnWorkspaceGate
): void {
  if (!catalog.isEnabled() || !gate.isLintActive()) {
    return;
  }
  void catalog
    .ensure({ showProgress: true })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `ServiceNow Records indexing failed: ${message}`
      );
    })
    .finally(() => treeProvider.refreshTree());
}

function maybeStartDeclarationIndex(index: ScriptDeclarationIndex): void {
  void index.ensure().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[servicenow-xml] declaration index failed:', message);
  });
}

/**
 * Wire diagnostics, commands, and search after the Records tree is available.
 */
function activateDiagnosticsAndCommands(
  context: vscode.ExtensionContext,
  catalog: RecordCatalog,
  treeProvider: RecordsTreeProvider,
  treeView: vscode.TreeView<TreeNode>,
  gate: SnWorkspaceGate,
  declarationIndex: ScriptDeclarationIndex
): void {
  const statusBar = new KindStatusBar();
  const diagnostics = new DiagnosticsController(
    statusBar,
    (document) => gate.isValidationAllowed(document),
    () => gate.getWorkspaceAppSysId(),
    () => gate.getWorkspaceJavaScriptSupport(),
    () => gate.getWorkspaceAppScope(),
    () => declarationIndex.getDeclarations()
  );
  context.subscriptions.push(
    statusBar,
    diagnostics,
    declarationIndex.onDidChange(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'xml') {
          diagnostics.schedule(doc);
        }
      }
    }),
    gate.onDidChange(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'xml') {
          diagnostics.schedule(doc);
        }
      }
      diagnostics.refreshActiveEditor();
      publishSnDocumentContext();
      maybeStartCatalogIndex(catalog, treeProvider, gate);
      maybeStartDeclarationIndex(declarationIndex);
    })
  );

  registerGoToRecord(context, catalog);

  context.subscriptions.push(
    vscode.commands.registerCommand('servicenowXml.showKind', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'xml') {
        void vscode.window.showInformationMessage(
          'Open a ServiceNow XML file to see its document kind.'
        );
        return;
      }
      diagnostics.refresh(editor.document);
      const label = statusBar.currentLabel;
      if (label) {
        void vscode.window.showInformationMessage(`ServiceNow XML kind: ${label}`);
      }
    }),
    vscode.commands.registerCommand('servicenowXml.revalidate', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'xml') {
        return;
      }
      diagnostics.refresh(editor.document);
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.enable', async () => {
      // A folderless window has no workspace settings file, so a Workspace write
      // throws; fall back to User so the view's enable button still works there.
      await vscode.workspace
        .getConfiguration('servicenowXml')
        .update(
          'navigator.enable',
          true,
          vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
        );
      treeProvider.refreshTree();
      maybeStartCatalogIndex(catalog, treeProvider, gate);
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.refresh', async () => {
      if (!catalog.isEnabled()) {
        void vscode.window.showInformationMessage(
          'Enable servicenowXml.navigator.enable to use the Records navigator.'
        );
        return;
      }
      try {
        await catalog.refresh({ showProgress: true });
        treeProvider.refreshTree();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `ServiceNow Records refresh failed: ${message}`
        );
      }
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.sortBy', async () => {
      const current = catalog.sortBy();
      const picked = await vscode.window.showQuickPick(
        SORT_BY_PICKS.map((item) => ({
          ...item,
          description:
            item.value === current
              ? `${item.description} (current)`
              : item.description
        })),
        { title: 'Sort Records by', placeHolder: 'Choose sort order' }
      );
      if (!picked) {
        return;
      }
      // Same folderless-window fallback as navigator.enable.
      await vscode.workspace
        .getConfiguration('servicenowXml')
        .update(
          'navigator.sortBy',
          picked.value,
          vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
        );
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.filter', async () => {
      if (!catalog.isEnabled()) {
        void vscode.window.showInformationMessage(
          'Enable servicenowXml.navigator.enable to use the Records navigator.'
        );
        return;
      }
      const value = await vscode.window.showInputBox({
        title: 'Filter Records',
        prompt: 'Filter by name, table, api_name, sys_id, or path',
        value: treeProvider.getFilterQuery(),
        placeHolder: 'e.g. CompareRowForm or sys_script_include'
      });
      if (value === undefined) {
        return;
      }
      treeProvider.setFilterQuery(value);
      syncRecordsFilterUi(treeView, treeProvider);
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.clearFilter', () => {
      treeProvider.clearFilter();
      syncRecordsFilterUi(treeView, treeProvider);
    }),
    vscode.commands.registerCommand(
      'servicenowXml.revealInExplorer',
      async (element?: unknown) => {
        const uri = getRecordUriFromTreeElement(element);
        if (!uri) {
          return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
      }
    ),
    vscode.commands.registerCommand(
      'servicenowXml.revealInFileExplorer',
      async (element?: unknown) => {
        const uri = getRecordUriFromTreeElement(element);
        if (!uri) {
          return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    ),
    vscode.commands.registerCommand('servicenowXml.cursor.installHelpers', async () => {
      const result = await installCursorHelpers(context, { force: true });
      registerCursorHelpersDisposal(context, result.pluginPath);
      if (result.skippedReason === 'not-cursor') {
        void vscode.window.showInformationMessage(
          'Cursor helpers only apply in Cursor (VS Code is unchanged).'
        );
        return;
      }
      if (!result.installed) {
        void vscode.window.showInformationMessage(
          result.messages.join(' ') || 'Cursor helpers did not install.'
        );
        return;
      }
      await suggestReloadAfterCursorHelpers(
        `Cursor helpers installed. MCP: ${result.mcpRegistered.join(', ') || 'none'}.`
      );
    }),
    vscode.commands.registerCommand('servicenowXml.cursor.runIndexer', async () => {
      await runRepoIndexer(context);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'xml') {
        diagnostics.schedule(doc);
        publishSnDocumentContext();
        if (
          catalog.isEnabled() &&
          catalog.isLoaded() &&
          catalog.hasUri(doc.uri)
        ) {
          catalog.recordDocumentOpen(doc.uri);
        }
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'xml') {
        diagnostics.schedule(e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.close(doc);
      if (doc.languageId === 'xml') {
        publishSnDocumentContext();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      diagnostics.refreshActiveEditor();
      publishSnDocumentContext();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      const diagnosticsChanged =
        e.affectsConfiguration('servicenowXml.enable') ||
        e.affectsConfiguration('servicenowXml.enabledForAllWindows') ||
        e.affectsConfiguration('servicenowXml.lintJavaScript') ||
        e.affectsConfiguration('servicenowXml.lintJson') ||
        e.affectsConfiguration('servicenowXml.ignoreGlobs') ||
        e.affectsConfiguration('servicenowXml.debounceMs');
      if (diagnosticsChanged) {
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.languageId === 'xml') {
            diagnostics.schedule(doc);
          }
        }
        maybeStartDeclarationIndex(declarationIndex);
      }
      if (e.affectsConfiguration('servicenowXml.navigator')) {
        treeProvider.refreshTree();
        if (e.affectsConfiguration('servicenowXml.navigator.enable')) {
          maybeStartCatalogIndex(catalog, treeProvider, gate);
          if (treeView.visible && catalog.isEnabled()) {
            treeProvider.setViewVisible(true);
          }
        }
      }
      if (
        isCursorHost() &&
        (e.affectsConfiguration('servicenowXml.cursorHelpers.enable') ||
          e.affectsConfiguration('servicenowXml.cursorHelpers.installIndexHook') ||
          e.affectsConfiguration('servicenowXml.cursorHelpers.pythonPath'))
      ) {
        void installCursorHelpers(context).then((result) => {
          registerCursorHelpersDisposal(context, result.pluginPath);
          if (cursorHelpersNeedReload(result)) {
            void suggestReloadAfterCursorHelpers('Cursor helpers updated.');
          }
        });
      }
    })
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'xml') {
      diagnostics.schedule(doc);
    }
  }
  diagnostics.refreshActiveEditor();
  publishSnDocumentContext();
}

/**
 * Publish `servicenowXml.hasSnDocument` for the Records view `when` clause, true
 * when any open XML document looks like a ServiceNow export. Keeps the navigator
 * reachable for one-off exports in windows with no app marker.
 *
 * Not refreshed on every keystroke: `onDidChangeTextDocument` would rescan every
 * open document per edit, and a buffer that becomes export-shaped mid-typing is
 * picked up on the next open or editor switch.
 */
function publishSnDocumentContext(): void {
  const hasSnDocument = vscode.workspace.textDocuments.some(
    (doc) => doc.languageId === 'xml' && looksLikeSnExportDocument(doc)
  );
  void vscode.commands.executeCommand(
    'setContext',
    'servicenowXml.hasSnDocument',
    hasSnDocument
  );
}

/**
 * Sync the Records view filter banner and clear-filter context key.
 */
function syncRecordsFilterUi(
  treeView: vscode.TreeView<TreeNode>,
  treeProvider: RecordsTreeProvider
): void {
  const query = treeProvider.getFilterQuery();
  treeView.message = query ? `Filter: ${query}` : undefined;
  void vscode.commands.executeCommand(
    'setContext',
    'servicenowXml.recordsFiltered',
    Boolean(query)
  );
}

export function deactivate(): void {
  // Disposals handled via subscriptions
}
