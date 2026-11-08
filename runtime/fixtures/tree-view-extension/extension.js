/*---------------------------------------------------------------------------------------------
 *  DSH tree-view probe — a minimal VS Code extension that contributes one tree view.
 *
 *  DSH-authored (MIT).
 *
 *  It exists to answer one question with evidence: does an extension's `TreeDataProvider`
 *  reach the DSH right-Sidebar page, lazily, with the rows VS Code would have drawn?
 *--------------------------------------------------------------------------------------------*/

const vscode = require('vscode');

/** One node. The provider is LAZY: children are produced only when asked for. */
class Node {
	/**
	 * @param {string} label - the row label.
	 * @param {boolean} hasChildren - whether the row expands.
	 * @param {string} [command] - the command the row runs when picked.
	 */
	constructor(label, hasChildren, command) {
		this.label = label;
		this.hasChildren = hasChildren;
		this.command = command;
	}
}

/** The rows under one parent label. */
const TREE = {
	root: [new Node('alpha', true), new Node('beta', false, 'dshProbe.say')],
	alpha: [new Node('alpha-1', false), new Node('alpha-2', false)],
};

/** A TreeDataProvider that logs every call, so the driver can prove laziness. */
class ProbeProvider {
	/**
	 * @param {any} [element] - the row being expanded; omitted for the root.
	 * @returns {Node[]} the rows.
	 */
	getChildren(element) {
		console.log(`[tree-probe] getChildren(${element === undefined ? 'root' : element.label})`);
		return TREE[element === undefined ? 'root' : element.label] ?? [];
	}

	/**
	 * @param {Node} element - the row.
	 * @returns {number} the collapsible state.
	 */
	getTreeItem(element) {
		const item = new vscode.TreeItem(element.label, element.hasChildren
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None);
		item.description = `desc for ${element.label}`;
		if (element.command !== undefined) {
			item.command = { command: element.command, title: 'Say', arguments: [element.label] };
		}
		return item;
	}
}

/**
 * Activate.
 *
 * @param {any} context - the extension context.
 * @returns {void}
 */
function activate(context) {
	context.subscriptions.push(vscode.window.createTreeView('dshProbe.tree', {
		treeDataProvider: new ProbeProvider(),
	}));
	// A status bar item beside the tree: DSH owns the strip the workbench would have
	// shown, so the entry has to reach the page with its text and its command.
	// Read and write through the extension's own file system API: this is the
	// half of "editing a file with an extension" that the preview cannot show.
	context.subscriptions.push(vscode.commands.registerCommand('dshProbe.writeFile', async () => {
		const target = vscode.Uri.joinPath(context.extensionUri, 'probe-written.txt');
		await vscode.workspace.fs.writeFile(target, Buffer.from('written by the probe extension', 'utf8'));
		return target.fsPath;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('dshProbe.readFile', async () => {
		const target = vscode.Uri.joinPath(context.extensionUri, 'probe-written.txt');
		const bytes = await vscode.workspace.fs.readFile(target);
		return Buffer.from(bytes).toString('utf8');
	}));
	const status = vscode.window.createStatusBarItem('dshProbe.status', vscode.StatusBarAlignment.Left, 10);
	status.text = '$(check) probe ok';
	status.tooltip = 'the tree probe is running';
	status.command = 'dshProbe.say';
	status.show();
	context.subscriptions.push(status);
	// A command that READS the configuration: after the page writes a setting, running
	// this proves the new value reached the running extension, not only the disk.
	context.subscriptions.push(vscode.commands.registerCommand('dshProbe.readSetting', () => {
		return vscode.workspace.getConfiguration('dshProbe').get('greeting');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('dshProbe.say', (label) => {
		console.log(`[tree-probe] say ${label}`);
		return `said ${label}`;
	}));
	console.log('[tree-probe] activated');
}

exports.activate = activate;
