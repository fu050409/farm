import { createRequire } from 'node:module';

import { FSWatcher } from 'chokidar';

import { Compiler } from '../compiler/index.js';
import { Server } from '../server/index.js';
import { Logger, compilerHandler, normalizeBasePath } from '../utils/index.js';

import { existsSync } from 'node:fs';
import type { ResolvedUserConfig } from '../config/index.js';
import type { JsUpdateResult } from '../types/binding.js';
import { createWatcher } from './create-watcher.js';

interface ImplFileWatcher {
  watch(): Promise<void>;
}

export class FileWatcher implements ImplFileWatcher {
  private _root: string;
  private _watcher: FSWatcher;
  private _close = false;
  private _watchedFiles = new Set<string>();
  public server: Server | null = null;
  public compiler: Compiler;

  constructor(
    serverOrCompiler: Server | Compiler,
    public options: ResolvedUserConfig,
    private _logger: Logger
  ) {
    this._root = options.root;
    if (serverOrCompiler instanceof Server) {
      this.server = serverOrCompiler;
      this.compiler = serverOrCompiler.getCompiler();
    } else {
      this.compiler = serverOrCompiler;
    }
  }

  getInternalWatcher() {
    return this._watcher;
  }

  private filterWatchFile(file: string): boolean {
    file = normalizeBasePath(file);

    if (file.startsWith(`${this._root}/`) || file.includes('\0')) return false;

    for (const watchedFile of this._watchedFiles) {
      if (file.startsWith(watchedFile)) return false;
    }

    return existsSync(file);
  }

  getExtraWatchedFiles() {
    const compiler = this.compiler;

    return [
      ...compiler.resolvedModulePaths(this._root),
      ...compiler.resolvedWatchPaths()
    ].filter((file) => this.filterWatchFile(file));
  }

  watchExtraFiles() {
    const files = this.getExtraWatchedFiles();

    for (const file of files) {
      if (!this._watchedFiles.has(file)) {
        this._watcher.add(file);
        this._watchedFiles.add(file);
      }
    }
  }

  async watch() {
    const compiler = this.compiler;

    const handlePathChange = async (path: string): Promise<void> => {
      if (this._close) {
        return;
      }

      try {
        this.server && (await this.server.hmrEngine.hmrUpdate(path));

        // Determine how to compile the project
        if (!this.server && compiler.hasModule(path)) {
          compilerHandler(
            async () => {
              const result = await compiler.update([path], true);
              handleUpdateFinish(result);
              compiler.writeResourcesToDisk();
            },
            this.options,
            this._logger,
            { clear: true }
          );
        }
      } catch (error) {
        this._logger.error(error);
      }
    };

    const watchedFiles = this.getExtraWatchedFiles();

    const files = [this.options.root, ...watchedFiles];
    this._watchedFiles = new Set(files);
    this._watcher = createWatcher(this.options, files);

    this._watcher.on('change', (path) => {
      if (this._close) return;
      handlePathChange(path);
    });

    const handleUpdateFinish = (updateResult: JsUpdateResult) => {
      const added = [
        ...updateResult.added,
        ...updateResult.extraWatchResult.add
      ].map((addedModule) => {
        const resolvedPath = compiler.transformModulePath(
          this._root,
          addedModule
        );
        return resolvedPath;
      });
      const filteredAdded = added.filter((file) => this.filterWatchFile(file));

      if (filteredAdded.length > 0) {
        this._watcher.add(filteredAdded);
        filteredAdded.forEach((file) => this._watchedFiles.add(file));
      }
    };

    if (this.server) {
      this.server.hmrEngine?.onUpdateFinish(handleUpdateFinish);
    }
  }

  close() {
    this._close = true;
    this._watcher = null;
    this.server = null;
    this.compiler = null;
  }
}

export function clearModuleCache(modulePath: string) {
  const _require = createRequire(import.meta.url);
  delete _require.cache[_require.resolve(modulePath)];
}
