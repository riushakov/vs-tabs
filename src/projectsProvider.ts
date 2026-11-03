import * as vscode from 'vscode';
import { ProjectManager } from './projectManager';

export class ProjectsProvider implements vscode.TreeDataProvider<ProjectItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private manager: ProjectManager) {
        manager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ProjectItem[] {
        const projects = this.manager.listProjects();
        return projects.map((p: string) => new ProjectItem(p, this.manager));
    }
}

export class ProjectItem extends vscode.TreeItem {
    constructor(public readonly folder: string, manager: ProjectManager) {
        const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
        super(name, vscode.TreeItemCollapsibleState.None);

        this.tooltip = folder;
        this.description = manager.isCurrent(folder) ? '● текущий' : undefined;

        this.command = {
            command: 'vsTabs.switchToPath',
            title: 'Переключиться на проект',
            arguments: [folder]
        };

        this.iconPath = new vscode.ThemeIcon(manager.isCurrent(folder) ? 'folder-active' : 'folder');
        this.contextValue = 'projectItem';
    }
}