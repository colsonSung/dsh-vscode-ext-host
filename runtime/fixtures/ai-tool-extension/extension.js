/*---------------------------------------------------------------------------------------------
 *  DSH D-class probe — a minimal VS Code extension that contributes one language model tool.
 *
 *  DSH-authored (MIT).
 *
 *  It exists to answer one question with evidence: does a VS Code extension's
 *  `contributes.languageModelTools` + `vscode.lm.registerTool(...)` reach the DSH tool registry
 *  through the main-thread D-class bridge?
 *
 *  The extension also reports what the extension host itself sees, so the driver can assert on
 *  `vscode.lm.tools` from *inside* the extension host.
 *--------------------------------------------------------------------------------------------*/

const vscode = require('vscode');

/** The tool id this extension contributes. */
const TOOL_ID = 'dsh-probe_echo';

/**
 * A tool that echoes its input back.
 */
class EchoTool {
	/**
	 * @param {any} options - the invocation options.
	 * @returns {Promise<any>} the tool result.
	 */
	async invoke(options) {
		const text = options && options.input ? options.input.text : '';
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`echo: ${text}`),
		]);
	}

	/**
	 * @returns {Promise<any>} the preparation, including the confirmation copy DSH must show.
	 */
	async prepareInvocation() {
		return {
			invocationMessage: 'echoing the text back',
			confirmationMessages: {
				title: 'Run the DSH echo tool?',
				message: 'The echo tool prints the given text back to the caller.',
			},
		};
	}
}

/**
 * @param {any} context - the extension context.
 * @returns {any} the extension's public API.
 */
function activate(context) {
	context.subscriptions.push(vscode.lm.registerTool(TOOL_ID, new EchoTool()));
	return {
		toolId: TOOL_ID,
		/** The tools the extension host reports, as seen from inside the extension. */
		tools: () => vscode.lm.tools.map(tool => ({ name: tool.name, description: tool.description })),
	};
}

function deactivate() { }

module.exports = { activate, deactivate };
