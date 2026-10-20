/**
 * Injected IO for the vscode-free Registry (tests, MCP, future LSP).
 */

/** Minimal filesystem used by cache and pack loaders. */
export interface RegistryFileSystem {
  readFile(path: string, encoding?: 'utf8'): Promise<string>;
  writeFile(path: string, contents: string, encoding?: 'utf8'): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir?(path: string): Promise<string[]>;
}

/** Workspace roots as path strings (not vscode.Uri). */
export interface RegistryWorkspaceRoots {
  getRoots(): string[];
}

/** Clock for mtime / cache stamps. */
export interface RegistryClock {
  now(): number;
}

/** Host bundle passed into Registry services. */
export interface RegistryHost {
  fs: RegistryFileSystem;
  roots: RegistryWorkspaceRoots;
  clock: RegistryClock;
}
