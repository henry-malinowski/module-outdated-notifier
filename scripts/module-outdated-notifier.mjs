import SettingsConfig from "./settings-config.mjs";
import { MODULE_ID } from "./_constants.mjs";

// ============================================================================
// Constants
// ============================================================================

const MODULE_NAME = "Module Outdated Notifier";
const API_ENDPOINT = "https://foundryvtt.com/_api/packages/get";
const INITIAL_CHECK_DELAY = 7500; // ms
const PROCESSING_CHUNK_SIZE = 500;

// optimistically compile template during initialization to avoid loading external file
const UPDATE_MESSAGE_TEMPLATE = Handlebars.compile(`
	<h4>{{title}}</h4>
	<ul>
		{{#each updates}}
			<li>
				<strong>{{this.title}}</strong>: {{this.current}} &rarr; {{this.latest}}
				{{#if this.releaseNotes}}
					<br><a href="{{this.releaseNotes}}" target="_blank">{{../releaseNotesLabel}}</a>
				{{/if}}
			</li>
		{{/each}}
	</ul>
`);

// ============================================================================
// Module State
// ============================================================================

/**
 * Store available updates at module level so hooks can access them.
 * @type {Array<object>}
 */
let availableUpdates = [];

// ============================================================================
// Initialization
// ============================================================================

Hooks.once("init", registerSettings);
Hooks.once("ready", onReady);

// ============================================================================
// Settings Registration
// ============================================================================

/**
 * Register module settings.
 */
function registerSettings() {
	/* If the user sets a key, immediately check for updates. */
	game.settings.register(MODULE_ID, "apiKey", {
		name: "module-outdated-notifier.settings.apiKey.name",
		hint: "module-outdated-notifier.settings.apiKey.hint",
		scope: "world",
		config: false,
		type: String,
		default: "",
		onChange: () => checkAndNotifyUpdates()
	});

	game.settings.registerMenu(MODULE_ID, "settingsMenu", {
		name: "module-outdated-notifier.settings.settingsMenu.name",
		label: "module-outdated-notifier.settings.settingsMenu.label",
		icon: "fas fa-key",
		type: SettingsConfig,
		restricted: true
	});
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch the list of packages from the Foundry VTT repository.
 * @returns {Promise<object>} The package list response.
 * @throws {Error} If API key is missing or request fails.
 */
async function fetchPackageList() {
	const apiKey = game.settings.get(MODULE_ID, "apiKey");

	if (!apiKey) {
		throw new Error(game.i18n.localize("module-outdated-notifier.notifications.apiKeyRequired.message"));
	}

	const response = await fetch(API_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `APIKey:${apiKey}`
		},
		body: JSON.stringify({
			type: "module",
			version: game.version
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch package list: ${response.statusText}`);
	}

	return response.json();
}

// ============================================================================
// Update Checking
// ============================================================================

/**
 * Process an array in chunks to yield to the main thread and avoid blocking.
 * @param {Array} items - The array to process.
 * @param {Function} callback - The function to call for each item.
 * @param {number} [chunkSize=500] - The number of items to process per chunk.
 * @returns {Promise<void>}
 */
function processInChunks(items, callback, chunkSize = PROCESSING_CHUNK_SIZE) {
	return new Promise((resolve) => {
		let index = 0;

		function nextChunk() {
			const end = Math.min(index + chunkSize, items.length);

			for (; index < end; index++) {
				callback(items[index]);
			}

			if (index < items.length) {
				setTimeout(nextChunk, 0);
			} else {
				resolve();
			}
		}

		nextChunk();
	});
}

/**
 * Build a map of remote packages indexed by module name.
 * @param {Array} remotePackages - The packages from the API response.
 * @returns {Promise<Map<string, object>>} A map of module names to package data.
 */
async function buildRemotePackageMap(remotePackages) {
	const remoteMap = new Map();

	await processInChunks(remotePackages, (pkg) => {
		if (pkg.name && pkg.version) {
			remoteMap.set(pkg.name, pkg);
		}
	});

	return remoteMap;
}

/**
 * Check if a module has an available update.
 * @param {object} module - The installed module.
 * @param {object} remote - The remote package data.
 * @returns {object|null} Update data if available, null otherwise.
 */
function getModuleUpdate(module, remote) {
	if (!remote?.version) return null;

	// remove leading 'v' from version strings
	// this shouldn't be common, but a few module maintainers mistakenly include it in their registration
	const current = module.version.replace(/^v/, "");
	const latest = remote.version.version.replace(/^v/, "");

	if (!foundry.utils.isNewerVersion(latest, current)) {
		return null;
	}

	return {
		id: module.id,
		title: module.title,
		current,
		latest,
		compatibleCore: remote.version.compatible_core_version,
		releaseNotes: remote.version.notes || null
	};
}

/**
 * Check all installed modules against the Foundry VTT repository for updates.
 * @returns {Promise<Array<object>|null>} A list of update data for outdated modules, or null if check failed.
 */
async function checkForUpdates() {
	const apiKey = game.settings.get(MODULE_ID, "apiKey");

	if (apiKey === "") {
		notifyApiKeyRequired();
		return null;
	}

	try {
		const response = await fetchPackageList();

		if (response.status !== "success" || !Array.isArray(response.packages)) {
			console.error(`${MODULE_NAME} | Invalid response from package repository`);
			return null;
		}

		const remoteMap = await buildRemotePackageMap(response.packages);
		const installedModules = Array.from(game.modules.values())
			.filter(m => m.active);
		const updates = [];

		await processInChunks(installedModules, (module) => {
			const update = getModuleUpdate(module, remoteMap.get(module.id));
			if (update) {
				updates.push(update);
			}
		});

		return updates;
	} catch (error) {
		console.error(`${MODULE_NAME} | Failed to check for updates:`, error);
		return null;
	}
}

// ============================================================================
// Notification Functions
// ============================================================================

/**
 * Create a chat message notifying that an API key is required.
 */
function notifyApiKeyRequired() {
	const module = game.modules.get(MODULE_ID);
	const message = game.i18n.format("module-outdated-notifier.notifications.apiKeyRequired.message", {
		"link": `<a href="${module.readme}">`,
		"/link": "</a>"
	});

	ChatMessage.create({
		content: `
			<h4>${MODULE_NAME}</h4>
			<p>${message}</p>
		`,
		whisper: [game.user.id],
		speaker: { alias: MODULE_NAME }
	});
}

/**
 * Check for updates and notify GMs if any are available.
 */
async function checkAndNotifyUpdates() {
	const updates = await checkForUpdates();

	if (updates === null) {
		return;
	}

	if (updates.length > 0) {
		notifyUpdatesAvailable(updates);
		availableUpdates = updates;
		registerModuleManagementHook();
	} else {
		notifyAllUpToDate();
	}
}

/**
 * Create a chat message with available updates.
 * @param {Array<object>} updates - The list of available updates.
 */
function notifyUpdatesAvailable(updates) {
	const content = UPDATE_MESSAGE_TEMPLATE({
		updates,
		title: game.i18n.localize("module-outdated-notifier.notifications.updatesAvailable.title"),
		releaseNotesLabel: game.i18n.localize("module-outdated-notifier.notifications.releaseNotes")
	});
	const gmUserIds = game.users
		.filter(u => u.isGM)
		.map(u => u.id);

	ChatMessage.create({
		content,
		whisper: gmUserIds,
		speaker: { alias: MODULE_NAME }
	});
}

/**
 * Create a UI notification that all modules are up to date.
 */
function notifyAllUpToDate() {
	ui.notifications.info("module-outdated-notifier.notifications.allUpToDate", {localize: true});
}

// ============================================================================
// Module Management UI Hooks
// ============================================================================

/**
 * Handle rendering of the Module Management window to display update indicators.
 * @param {Application} _app - The application instance.
 * @param {HTMLElement} html - The rendered HTML element.
 * @param {object} _data - The data used for rendering.
 */
function onRenderModuleManagement(_app, html, _data) {
	for (const update of availableUpdates) {
		const badge = html.querySelector(`li[data-module-id="${update.id}"] .tags > .tag.badge`);
		if (!badge) continue;

		badge.classList.add("update-available");
		badge.querySelector("i").className = "fa-solid fa-fw fa-chevrons-up";

		const existingTooltip = badge.getAttribute("data-tooltip-html") ?? "";
		const releaseNotesLink = update.releaseNotes
			? `<br><a href="${update.releaseNotes}" target="_blank">${game.i18n.localize("module-outdated-notifier.notifications.releaseNotes")}</a>`
			: "";
		const updateText = game.i18n.format("module-outdated-notifier.notifications.updateAvailable", {
			version: update.latest
		});
		badge.setAttribute("data-tooltip-html", `${existingTooltip}<br>${updateText}${releaseNotesLink}`);
		if (releaseNotesLink) {
			badge.setAttribute("data-locked", "");
		}
	}
}

/**
 * Register the renderModuleManagement hook.
 * Only called after updates are found to avoid unnecessary hook registrations.
 */
function registerModuleManagementHook() {
	Hooks.on("renderModuleManagement", onRenderModuleManagement);
}

// ============================================================================
// Lifecycle Hooks
// ============================================================================

/**
 * Perform initial update check when the game is ready.
 * Only runs for the first active GM to avoid duplicate checks.
 */
async function onReady() {
	if (!game.user.isGM) return;

	const activeGMs = game.users
		.filter(u => u.active && u.isGM)
		.sort((a, b) => a.id.localeCompare(b.id));

	if (activeGMs[0]?.id !== game.user.id) return;

	setTimeout(() => {
		checkAndNotifyUpdates();
	}, INITIAL_CHECK_DELAY);
}
