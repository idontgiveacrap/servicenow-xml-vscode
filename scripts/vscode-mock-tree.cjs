class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class Uri {
  constructor(value) {
    this.value = value;
    this.scheme = 'file';
    this.fsPath = value;
  }

  toString() {
    return this.value;
  }
}

module.exports = {
  EventEmitter,
  TreeItem: class TreeItem {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class ThemeIcon {},
  ThemeColor: class ThemeColor {},
  Uri: {
    file: (value) => new Uri(value),
    parse: (value) => new Uri(value)
  },
  window: {
    showErrorMessage() {},
    showWarningMessage() {},
    showInformationMessage() {}
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration() {
      return { get: (_key, fallback) => fallback };
    },
    getWorkspaceFolder() {
      return undefined;
    }
  },
  commands: { registerCommand() { return { dispose() {} }; } },
  Disposable: class Disposable {}
};
