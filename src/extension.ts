import * as vscode from 'vscode';
import { ProjectManager } from './projectManager';
import { ProjectsProvider } from './projectsProvider';

export function activate(context: vscode.ExtensionContext) {
    const manager = new ProjectManager(context);
    const provider = new ProjectsProvider(manager);

    manager.tryApplyPendingRestore();

    const treeView = vscode.window.createTreeView('vsTabsView', {
        treeDataProvider: provider,
        showCollapseAll: false
    });
    context.subscriptions.push(treeView);

    let statusItems: vscode.StatusBarItem[] = [];
    const disposeStatusItems = () => {
        statusItems.forEach(i => i.dispose());
        statusItems = [];
    };

    const rebuildStatusBar = () => {
        disposeStatusItems();
        const projects = manager.listProjects();
        const current = manager.getCurrentProject();
        const ordered = [...projects].sort((a, b) => {
            if (a === current) return -1;
            if (b === current) return 1;
            return a.localeCompare(b);
        });
        ordered.forEach((folder, index) => {
            const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
            const isCurrent = folder === current;
            const item = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Left,
                1000 - index
            );
            item.text = `${isCurrent ? '$(folder-active)' : '$(folder)'} ${name}`;
            item.tooltip = isCurrent ? `Текущий проект: ${folder}` : `Переключиться на: ${folder}`;
            item.command = {
                title: 'Переключиться на проект',
                command: 'vsTabs.switchToPath',
                arguments: [folder]
            };
            if (isCurrent) {
                item.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            }
            item.show();
            statusItems.push(item);
        });
    };

    rebuildStatusBar();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => rebuildStatusBar()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            rebuildStatusBar();
            provider.refresh();
        }),
        manager.onDidChange(() => {
            rebuildStatusBar();
            provider.refresh();
        }),
        vscode.window.tabGroups.onDidChangeTabs(() => {
            manager.captureCurrentQuietly();
        }),
        { dispose: disposeStatusItems }
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vsTabs.addFolders', () => manager.addFolders()),
        vscode.commands.registerCommand('vsTabs.addCurrentProject', () => manager.addCurrentProject()),
        vscode.commands.registerCommand('vsTabs.switchProject', () => manager.switchProject()),
        vscode.commands.registerCommand('vsTabs.removeProject', () => manager.removeProject()),
        vscode.commands.registerCommand('vsTabs.refresh', () => provider.refresh()),
        vscode.commands.registerCommand('vsTabs.switchToPath', (folder: string) => manager.switchTo(folder)),
        vscode.commands.registerCommand('vsTabs.removeByPath', (folder: string) => manager.removeByPath(folder)),
        vscode.commands.registerCommand('vsTabs.removeFromList', (item: any) => manager.confirmAndRemoveByPath(item.folder))
    );
}

export function deactivate() {}