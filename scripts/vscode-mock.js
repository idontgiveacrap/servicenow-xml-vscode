/** Minimal vscode stub for node smoke bundles. */
module.exports = {
  workspace: {
    getWorkspaceFolder: () => undefined,
    workspaceFolders: []
  },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
    showTextDocument: async () => undefined,
    activeTextEditor: undefined
  },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => `file://${p}` })
  },
  ViewColumn: { Beside: 2 },
  WorkspaceEdit: class {
    replace() {}
  },
  Range: class {
    constructor() {}
  },
  languages: {
    setTextDocumentLanguage: async () => undefined
  }
};
