/*---------------------------------------------------------------------------------------------
 *  Status bar — the `MainThreadStatusBar` channel.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT A STATUS BAR ITEM IS, IN VS CODE
 *  -------------------------------------
 *  `vscode.window.createStatusBarItem()` makes a small, always-visible control at the bottom
 *  of the workbench: an extension's state ("YAML: valid"), or a one-click action. If it has a
 *  command, clicking it runs that command.
 *
 *  WHAT DSH DOES
 *  -------------
 *  DSH has no workbench status bar. The right-Sidebar VS Code page therefore owns one: this
 *  module records the entries the extensions publish (and the ones they change), and the page
 *  draws a strip at its foot. A click runs the entry's command through the host, exactly as
 *  VS Code would.
 *
 *  The entries are keyed by the extension host's own entry id, so an extension that updates an
 *  item's text updates the same strip slot instead of adding another one.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';

/**
 * Read the plain text a tooltip carries.
 *
 * The extension host sends a serialized `MarkdownString`, so the value lives under `value`.
 *
 * @param tooltip - the serialized tooltip.
 * @returns the text, or undefined when there is nothing to show.
 */
function tooltipText(tooltip: unknown): string | undefined {
	if (typeof tooltip === 'string') {
		return tooltip.length > 0 ? tooltip : undefined;
	}
	if (tooltip !== null && typeof tooltip === 'object') {
		const value = (tooltip as { value?: unknown }).value;
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}
	return undefined;
}

/**
 * The handlers for the `MainThreadStatusBar` channel.
 *
 * @param _ctx - the DSH Host plugin context (unused: an entry is host-process state).
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createStatusBarMethods: MainThreadMethodFactory = (_ctx: any, host: ExtHostContext) => ({
	/**
	 * An extension published, or changed, one status bar entry.
	 *
	 * @param entryId - the extension host's entry id: the strip's stable slot.
	 * @param id - the id the extension gave the item, when it gave one.
	 * @param extensionId - the owning extension.
	 * @param name - the accessible name of the item.
	 * @param text - the text, which may carry `$(icon)` codicon placeholders.
	 * @param tooltip - the serialized tooltip.
	 * @param hasTooltipProvider - whether the tooltip is resolved lazily (DSH keeps the text).
	 * @param command - the internal command the item runs when clicked.
	 * @param color - the foreground theme colour id.
	 * @param backgroundColor - the background theme colour id.
	 * @param alignLeft - whether the item sits on the left group.
	 * @param priority - the ordering within the group.
	 * @param accessibilityInformation - the accessible label and role.
	 */
	'$setEntry'(
		entryId: string,
		id: unknown,
		extensionId: unknown,
		name: unknown,
		text: unknown,
		tooltip: unknown,
		hasTooltipProvider: unknown,
		command: unknown,
		color: unknown,
		backgroundColor: unknown,
		alignLeft: unknown,
		priority: unknown,
		accessibilityInformation: unknown,
	): void {
		host.setStatusBarEntry({
			entryId,
			id: typeof id === 'string' ? id : undefined,
			extensionId: typeof extensionId === 'string' ? extensionId : undefined,
			name: typeof name === 'string' ? name : undefined,
			text: typeof text === 'string' ? text : '',
			tooltip: tooltipText(tooltip),
			hasTooltipProvider: hasTooltipProvider === true,
			command: command !== null && typeof command === 'object' && typeof (command as { id?: unknown }).id === 'string'
				? { id: (command as { id: string }).id, title: typeof (command as { title?: unknown }).title === 'string' ? (command as { title: string }).title : undefined }
				: undefined,
			color: typeof color === 'string' ? color : undefined,
			backgroundColor: typeof backgroundColor === 'string' ? backgroundColor : undefined,
			alignLeft: alignLeft !== false,
			priority: typeof priority === 'number' ? priority : undefined,
			accessibilityInformation: accessibilityInformation !== null && typeof accessibilityInformation === 'object'
				? {
					label: typeof (accessibilityInformation as { label?: unknown }).label === 'string' ? (accessibilityInformation as { label: string }).label : undefined,
					role: typeof (accessibilityInformation as { role?: unknown }).role === 'string' ? (accessibilityInformation as { role: string }).role : undefined,
				}
				: undefined,
		});
	},

	/**
	 * An extension hid or disposed one status bar entry.
	 *
	 * @param entryId - the entry the extension host published it under.
	 */
	'$disposeEntry'(entryId: string): void {
		host.disposeStatusBarEntry(entryId);
	},
});
