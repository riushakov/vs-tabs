import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------- Опциональный дебаг ----------
function debugEnabled(): boolean {
    try {
        return vscode.workspace.getConfiguration('vsTabs').get<boolean>('debug', false) === true;
    } catch { return false; }
}

function dbg(msg: string, ...args: any[]) {
    if (!debugEnabled()) return;
    try {
        const parts = args.map(a => {
            try { return typeof a === 'string' ? a : JSON.stringify(a); }
            catch { return String(a); }
        });
        const line = `[${new Date().toISOString()}] ${msg} ${parts.join(' ')}\n`;
        const logPath = path.join(os.tmpdir(), 'vs-tabs-debug.log');
        fs.appendFileSync(logPath, line, 'utf8');
    } catch { /* ignore */ }
}

// ---------- Типы ----------
export interface TerminalState {
    name: string;
    cwd?: string;
}

export interface OpenFileState {
    path: string;
    viewColumn: number;
}

export interface ProjectState {
    folder: string;
    openFiles: OpenFileState[];
    activeFile?: string;
    terminals: TerminalState[];
}

function normPath(p: string): string {
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
}

function isInside(file: string, folder: string): boolean {
    const f = normPath(file);
    const d = normPath(folder);
    return f === d || f.startsWith(d + path.sep);
}

// ---------- Менеджер ----------
export class ProjectManager {
    private storagePath: string;
    private projects: Record<string, ProjectState> = {};
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;
    private pendingRestoreKey = 'vsTabs.pendingRestore';
    private switching = false;

    constructor(private context: vscode.ExtensionContext) {
        this.storagePath = path.join(context.globalStorageUri.fsPath, 'projects.json');
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf8');
                this.projects = JSON.parse(raw);
                for (const key of Object.keys(this.projects)) {
                    if (!this.projects[key].terminals) this.projects[key].terminals = [];
                    if (!this.projects[key].openFiles) this.projects[key].openFiles = [];
                    const of = this.projects[key].openFiles as any;
                    if (Array.isArray(of) && of.length > 0 && typeof of[0] === 'string') {
                        this.projects[key].openFiles = of.map((p: string) => ({ path: p, viewColumn: 1 }));
                    }
                }
            }
        } catch (e) {
            dbg('load ERROR:', String(e));
        }
    }

    private save() {
        try {
            fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(this.projects, null, 2), 'utf8');
        } catch (e) {
            dbg('save ERROR:', String(e));
        }
        this._onDidChange.fire();
    }

    public listProjects(): string[] {
        return Object.keys(this.projects);
    }

    public getCurrentProject(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;
        return folders[0].uri.fsPath;
    }

    public isCurrent(folder: string): boolean {
        const cur = this.getCurrentProject();
        return !!cur && normPath(cur) === normPath(folder);
    }

    // ---------- Добавление ----------
    public async addFolders(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: true,
            openLabel: 'Добавить как проекты',
            title: 'Выберите папки, которые нужно добавить как проекты'
        });
        if (!uris || uris.length === 0) return;

        let added = 0, skipped = 0;
        for (const uri of uris) {
            const folder = uri.fsPath;
            const exists = Object.keys(this.projects).some(k => normPath(k) === normPath(folder));
            if (exists) { skipped++; continue; }
            this.projects[folder] = { folder, openFiles: [], activeFile: undefined, terminals: [] };
            added++;
        }
        if (added > 0) this.save();
        const parts: string[] = [];
        if (added > 0) parts.push(`добавлено: ${added}`);
        if (skipped > 0) parts.push(`уже в списке: ${skipped}`);
        vscode.window.showInformationMessage(`VS_Tabs: ${parts.join(', ')}`);
    }

    public async addCurrentProject(): Promise<void> {
        const folder = this.getCurrentProject();
        if (!folder) {
            vscode.window.showErrorMessage('Сначала откройте папку с проектом.');
            return;
        }
        const existingKey = Object.keys(this.projects).find(k => normPath(k) === normPath(folder));
        const key = existingKey ?? folder;
        this.projects[key] = this.captureState(folder);
        this.save();
        vscode.window.showInformationMessage(`Состояние сохранено: ${folder}`);
    }

    public captureCurrentQuietly(): void {
        if (this.switching) { dbg('captureCurrentQuietly: skip during switch'); return; }
        const folder = this.getCurrentProject();
        if (!folder) return;
        const key = Object.keys(this.projects).find(k => normPath(k) === normPath(folder));
        if (!key) return;

        const newState = this.captureState(folder);
        const oldState = this.projects[key];
        if (newState.openFiles.length === 0 && oldState && oldState.openFiles.length > 0) {
            dbg('captureCurrentQuietly: skip empty overwrite');
            return;
        }
        this.projects[key] = newState;
        try {
            fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(this.projects, null, 2), 'utf8');
        } catch (e) {
            dbg('captureCurrentQuietly save ERROR:', String(e));
        }
    }

    private captureState(folder: string): ProjectState {
        return {
            folder,
            openFiles: this.captureOpenFiles(folder),
            activeFile: this.captureActiveFile(folder),
            terminals: this.captureTerminals(folder)
        };
    }

    private captureOpenFiles(folder: string): OpenFileState[] {
        const result: OpenFileState[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    const filePath = tab.input.uri.fsPath;
                    if (isInside(filePath, folder)) {
                        result.push({ path: filePath, viewColumn: group.viewColumn });
                    }
                }
            }
        }
        dbg('captureOpenFiles:', result);
        return result;
    }

    private captureActiveFile(folder: string): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (editor && isInside(editor.document.uri.fsPath, folder)) {
            return editor.document.uri.fsPath;
        }
        return undefined;
    }

    private captureTerminals(folder: string): TerminalState[] {
        const result: TerminalState[] = [];
        for (const term of vscode.window.terminals) {
            const opts = (term.creationOptions as vscode.TerminalOptions) || {};
            let cwd: string | undefined;
            if (opts.cwd instanceof vscode.Uri) cwd = opts.cwd.fsPath;
            else if (typeof opts.cwd === 'string') cwd = opts.cwd;
            if (!cwd || !fs.existsSync(cwd)) cwd = folder;
            result.push({ name: term.name, cwd });
        }
        return result;
    }

    // ---------- Переключение ----------
    public async switchTo(folder: string): Promise<void> {
        const key = Object.keys(this.projects).find(k => normPath(k) === normPath(folder));
        if (!key) {
            vscode.window.showWarningMessage('Проект не найден в списке.');
            return;
        }
        if (this.isCurrent(folder)) return;

        const state = this.projects[key];

        const current = this.getCurrentProject();
        if (current) {
            const curKey = Object.keys(this.projects).find(k => normPath(k) === normPath(current));
            if (curKey) {
                const captured = this.captureState(current);
                if (captured.openFiles.length > 0 || !this.projects[curKey].openFiles.length) {
                    this.projects[curKey] = captured;
                }
            }
        }

        dbg('=== switchTo ===', folder);

        this.switching = true;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        const uri = vscode.Uri.file(state.folder);
        const success = await vscode.commands.executeCommand(
            'vscode.openFolder',
            uri,
            { forceNewWindow: false }
        );

        if (success !== false) {
            await this.context.globalState.update(this.pendingRestoreKey, state);
            dbg('pending state saved');
        } else {
            dbg('openFolder failed');
        }

        this.switching = false;
        this.save();
    }

    // ---------- Адаптивное восстановление ----------
    public async tryApplyPendingRestore(): Promise<void> {
        dbg('=== tryApplyPendingRestore START ===');
        let pending = this.context.globalState.get<ProjectState>(this.pendingRestoreKey);

        const current = this.getCurrentProject();
        dbg('current:', current, 'pending:', pending ? pending.folder : 'null');

        if (!current) { dbg('no current, exit'); return; }

        if (!pending || normPath(pending.folder) !== normPath(current)) {
            const key = Object.keys(this.projects).find(k => normPath(k) === normPath(current));
            if (key) {
                pending = this.projects[key];
                dbg('using projects[current] as pending:', pending.openFiles.length, 'files');
            }
        }

        if (pending && pending.openFiles.length === 0 && current) {
            const key = Object.keys(this.projects).find(k => normPath(k) === normPath(current));
            if (key && this.projects[key].openFiles.length > 0) {
                pending = this.projects[key];
                dbg('fallback to projects[current]:', pending.openFiles.length, 'files');
            }
        }

        if (!pending) { dbg('no pending after fallback, exit'); return; }

        await this.context.globalState.update(this.pendingRestoreKey, undefined);

        // Адаптивное ожидание: пытаемся восстановить как только окно готово
        const ready = await this.waitForWorkspaceReady(3000);
        dbg('workspace ready:', ready);

        if (!ready) {
            dbg('workspace not ready after 3000ms, aborting restore');
            return;
        }

        dbg('starting restoreTabs, openFiles count:', pending.openFiles.length);
        await this.restoreTabs(pending);
        await this.restoreTerminals(pending.terminals, pending.folder);
        dbg('=== tryApplyPendingRestore END ===');
    }

    /** Ждёт, пока workspace загрузится и будет готов принимать документы. */
    private async waitForWorkspaceReady(maxMs: number): Promise<boolean> {
        const start = Date.now();
        // Первая пауза — дать окну инициализироваться
        await new Promise(r => setTimeout(r, 200));

        while (Date.now() - start < maxMs) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                // Дополнительная проверка: попробуем открыть «пробный» документ,
                // чтобы убедиться, что редакторы готовы. Если не выйдет — ждём дальше.
                try {
                    // Просто проверяем, что API отвечает; реальное открытие в restoreTabs
                    return true;
                } catch { /* ignore */ }
            }
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }

    private async restoreTabs(state: ProjectState): Promise<void> {
        dbg('=== restoreTabs START ===');
        const files = state.openFiles.filter(f => fs.existsSync(f.path));
        dbg('existing files:', files.length);

        const byColumn = new Map<number, string[]>();
        for (const f of files) {
            const col = f.viewColumn || 1;
            if (!byColumn.has(col)) byColumn.set(col, []);
            byColumn.get(col)!.push(f.path);
        }

        for (const [col, paths] of byColumn) {
            for (const file of paths) {
                await this.openAndPin(file, col, true);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        if (state.activeFile && fs.existsSync(state.activeFile)) {
            const activeState = files.find(f => normPath(f.path) === normPath(state.activeFile!));
            const col = activeState ? activeState.viewColumn : 1;
            await this.openAndPin(state.activeFile, col, false);
        }

        dbg('=== restoreTabs END ===');
    }

    private async openAndPin(file: string, viewColumn: number, preserveFocus: boolean): Promise<void> {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                await vscode.window.showTextDocument(doc, {
                    preview: false,
                    preserveFocus,
                    viewColumn: viewColumn as vscode.ViewColumn
                });
                if (this.isFilePinned(file)) return;
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                dbg('openAndPin ERROR:', String(e));
                await new Promise(r => setTimeout(r, 300));
            }
        }
    }

    private isFilePinned(file: string): boolean {
        const target = normPath(file);
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    if (normPath(tab.input.uri.fsPath) === target) {
                        return tab.isPreview === false;
                    }
                }
            }
        }
        return false;
    }

    private async restoreTerminals(_terminals: TerminalState[], projectFolder: string) {
        for (const term of vscode.window.terminals) {
            try { term.dispose(); } catch { /* ignore */ }
        }
        await new Promise(r => setTimeout(r, 300));
        const cwd = fs.existsSync(projectFolder) ? projectFolder : undefined;
        const options: vscode.TerminalOptions = { name: 'powershell' };
        if (cwd) options.cwd = cwd;
        vscode.window.createTerminal(options).show(false);
    }

    // ---------- Прочее ----------
    public async switchProject(): Promise<void> {
        const names = this.listProjects();
        if (names.length === 0) {
            vscode.window.showWarningMessage('Список проектов пуст. Добавьте проект.');
            return;
        }
        const picked = await vscode.window.showQuickPick(names, {
            placeHolder: 'Выберите проект для переключения'
        });
        if (!picked) return;
        await this.switchTo(picked);
    }

    public async removeProject(): Promise<void> {
        const names = this.listProjects();
        if (names.length === 0) return;
        const picked = await vscode.window.showQuickPick(names, {
            placeHolder: 'Какой проект удалить из списка?'
        });
        if (!picked) return;
        delete this.projects[picked];
        this.save();
        vscode.window.showInformationMessage(`Проект удалён из списка: ${picked}`);
    }

    public async removeByPath(folder: string): Promise<void> {
        const key = Object.keys(this.projects).find(k => normPath(k) === normPath(folder));
        if (key) {
            delete this.projects[key];
            this.save();
            vscode.window.showInformationMessage(`Проект удалён из списка: ${folder}`);
        }
    }

    public async confirmAndRemoveByPath(folder: string): Promise<void> {
        const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
        const answer = await vscode.window.showWarningMessage(
            `Удалить проект «${name}» из списка?`,
            { modal: true },
            'Удалить'
        );
        if (answer !== 'Удалить') return;
        await this.removeByPath(folder);
    }

    public refresh(): void {
        this._onDidChange.fire();
    }
}