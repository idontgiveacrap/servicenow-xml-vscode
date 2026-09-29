/**
 * Node fs bridge shared by MCP server (no vscode).
 */

import * as fs from 'fs/promises';
import type { RegistryFileSystem } from './host';

/**
 * Create a RegistryFileSystem backed by Node fs/promises.
 */
export function createNodeFileSystem(): RegistryFileSystem {
  return {
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(filePath, 'utf8');
    },
    async writeFile(filePath: string, contents: string): Promise<void> {
      await fs.writeFile(filePath, contents, 'utf8');
    },
    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(dirPath, { recursive: options?.recursive ?? false });
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
  };
}
