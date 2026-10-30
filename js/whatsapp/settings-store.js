/**
 * ============================================================================
 * Settings persistence
 * ============================================================================
 * Reads and writes `state.settings` to localStorage and keeps the controls
 * in the Settings drawer in step. The schema and validation live in
 * js/settings.js; this module has no opinion on what the values mean.
 * ============================================================================
 */
import { DEFAULT_SETTINGS, sanitizeSettings } from "../settings.js?v=1.8.11";
import { readStored, writeStored } from "../shared/safe-storage.js?v=1.8.11";
import { STORAGE_KEYS, state } from "./state.js?v=1.8.11";

const AUTO_CACHE_MIGRATION_KEY = "chatlume-auto-cache-enabled-v1";

export function loadSavedSettings() {
    try {
        const saved = JSON.parse(readStored(STORAGE_KEYS.settings) || "{}");
        state.settings = sanitizeSettings(saved);
        // Existing local installs may have a saved `false` from the old opt-in
        // default. Honor this feature request once, then let the Settings toggle
        // be the user's durable choice from that point on.
        if (readStored(AUTO_CACHE_MIGRATION_KEY) !== "1") {
            state.settings.persistentStorage = true;
            saveSettings();
            writeStored(AUTO_CACHE_MIGRATION_KEY, "1");
        }
    } catch (error) {
        console.warn("Unable to load settings:", error);
        state.settings = { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings() {
    writeStored(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

/** Pushes `state.settings` into every `[data-setting]` control. */
export function syncSettingsControls() {
    document.querySelectorAll("[data-setting]").forEach((control) => {
        const key = control.dataset.setting;
        if (!(key in state.settings)) return;

        if (control.type === "checkbox") {
            control.checked = Boolean(state.settings[key]);
            return;
        }
        control.value = state.settings[key];
    });
}
