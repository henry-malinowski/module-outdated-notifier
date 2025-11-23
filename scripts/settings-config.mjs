const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { StringField } = foundry.data.fields;
import { MODULE_ID } from "./_constants.mjs";

export default class SettingsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
	#extractedApiKey;
	#apiKeyField;

	static get DEFAULT_OPTIONS() {
		return {
			id: "mon-settings-config",
			tag: "form",
			window: {
				title: "module-outdated-notifier.settingsConfig.title",
				icon: "fas fa-key",
				resizable: false,
				contentClasses: ["standard-form"]
			},
			position: {
				width: 540,
				height: "auto"
			},
			form: {
				handler: SettingsConfig.#onSubmit,
				closeOnSubmit: true
			},
			actions: {
				save: SettingsConfig.#onSubmit
			}
		};
	}

	static PARTS = {
		form: {
			template: "modules/module-outdated-notifier/templates/settings-config.hbs"
		},
		footer: {
			template: "templates/generic/form-footer.hbs"
		}
	};

	async _prepareContext(options) {
		if (options.isFirstRender) {
			this.#extractedApiKey = game.settings.get(MODULE_ID, "apiKey");
			this.#apiKeyField = new StringField({
				required: true,
				label: "module-outdated-notifier.settingsConfig.field.label",
				hint: "module-outdated-notifier.settingsConfig.field.hint"
			});
		}

		return {
			apiKey: this.#extractedApiKey,
			field: this.#apiKeyField,
			buttons: [
				{ type: "submit", icon: "fas fa-save", label: "module-outdated-notifier.settingsConfig.button.save" }
			]
		};
	}

	_onRender(context, options) {
		super._onRender(context, options);
		
		const html = this.element;
		const fileInput = html.querySelector("#license-file-input");
		
		if (fileInput) {
			fileInput.addEventListener("change", this.#onFileSelect.bind(this));
		}
	}

	async #onFileSelect(event) {
		const files = event.target.files;
		if (files.length === 0) return;
		this.#processFile(files[0]);
	}

	async #processFile(file) {
		if (file.name !== "license.mjs") {
			ui.notifications.warn("module-outdated-notifier.settingsConfig.messages.fileWrongName", { localize: true });
			return;
		}

		const contents = await file.text();
		const match = contents.match(/static LICENSE_API_KEY="([^"]*)";/);

		if (match && match[1]) {
			this.#extractedApiKey = match[1];
			await this.render();
			ui.notifications.info("module-outdated-notifier.settingsConfig.messages.extractionSuccess", { localize: true });
		} else {
			ui.notifications.error("module-outdated-notifier.settingsConfig.messages.extractionError", { localize: true });
		}
	}

	static async #onSubmit(event, form, formData) {
		const apiKey = formData.object.apiKey;
		await game.settings.set(MODULE_ID, "apiKey", apiKey);
	}
}
