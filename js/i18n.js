/**
 * ============================================================================
 * Interface language
 * ============================================================================
 * Spanish is the source language: the markup and the strings passed to t()
 * are written in Spanish, and EN holds the English translation. Spanish is
 * the default so the app renders in Spanish without waiting for JavaScript.
 *
 * The choice is kept in localStorage and, when the self-hosted server is
 * present, mirrored to /api/settings so it survives across browsers and
 * devices.
 * ============================================================================
 */
import { EN } from "./i18n-dictionary.js?v=1.8.28";

const STORAGE_KEY = "chatlume-language";
export const SUPPORTED_LANGUAGES = Object.freeze(["es", "en"]);
export const DEFAULT_LANGUAGE = "es";

let language = readStoredLanguage();

function readStoredLanguage() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (SUPPORTED_LANGUAGES.includes(saved)) return saved;
    } catch {
        // Private mode or a locked-down browser: fall through to the default.
    }
    return DEFAULT_LANGUAGE;
}

export function getLanguage() {
    return language;
}

/** BCP 47 locale for Intl and toLocale* calls. */
export function getLocale() {
    return language === "es" ? "es-ES" : "en-US";
}

/** Replaces {name} placeholders in a translated string. */
function interpolate(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
}

/**
 * Translates a Spanish source string. In Spanish mode the source is returned
 * untouched, so any string that has not been added to the dictionary still
 * renders correctly.
 */
export function t(text, vars) {
    const source = String(text ?? "");
    if (language === "es") return interpolate(source, vars);
    return interpolate(EN[source] ?? source, vars);
}

/** True when the given Spanish source string has an English translation. */
export function hasTranslation(text) {
    return Object.prototype.hasOwnProperty.call(EN, String(text));
}

/**
 * Applies the active language to explicit translation hooks:
 *   data-i18n              textContent
 *   data-i18n-html         innerHTML (for strings that contain markup)
 *   data-i18n-placeholder  placeholder attribute
 *   data-i18n-title        title attribute
 *   data-i18n-aria-label   aria-label attribute
 *
 * Only marked elements are touched, so chat messages, sender names and file
 * names are never rewritten.
 */
export function applyI18n(root = document) {
    if (!root) return;

    root.querySelectorAll("[data-i18n]").forEach((element) => {
        element.textContent = t(element.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-html]").forEach((element) => {
        element.innerHTML = t(element.getAttribute("data-i18n-html"));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
        element.setAttribute("placeholder", t(element.getAttribute("data-i18n-placeholder")));
    });
    root.querySelectorAll("[data-i18n-title]").forEach((element) => {
        element.setAttribute("title", t(element.getAttribute("data-i18n-title")));
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
        element.setAttribute("aria-label", t(element.getAttribute("data-i18n-aria-label")));
    });
    root.querySelectorAll("[data-i18n-alt]").forEach((element) => {
        element.setAttribute("alt", t(element.getAttribute("data-i18n-alt")));
    });

    if (root === document) {
        document.documentElement.lang = language;
    }
    document.querySelectorAll("#setting-language, #ig-setting-language").forEach((select) => {
        select.value = language;
    });
}

async function readServerLanguage() {
    if (!/^https?:$/.test(window.location.protocol)) return null;
    try {
        const response = await fetch("/api/settings", {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });
        if (!response.ok) return null;
        const data = await response.json();
        return SUPPORTED_LANGUAGES.includes(data?.language) ? data.language : null;
    } catch {
        return null;
    }
}

async function writeServerLanguage(next) {
    if (!/^https?:$/.test(window.location.protocol)) return;
    try {
        await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: next })
        });
    } catch {
        // Offline or static hosting: localStorage remains the source of truth.
    }
}

/**
 * Applies the saved language, then adopts the server's choice when the
 * self-hosted API is available. Static hosting silently keeps localStorage.
 */
export async function initI18n() {
    applyI18n();
    const serverLanguage = await readServerLanguage();
    if (serverLanguage && serverLanguage !== language) {
        language = serverLanguage;
        try {
            localStorage.setItem(STORAGE_KEY, language);
        } catch {
            // Ignore storage failures.
        }
        applyI18n();
        document.documentElement.lang = language;
        // Content rendered before the server answered has to be repainted.
        window.dispatchEvent(new CustomEvent("chatlume:languagechange", { detail: { language } }));
    }
    return language;
}

/** Persists and applies a new language. Callers usually reload afterwards. */
export async function setLanguage(next) {
    if (!SUPPORTED_LANGUAGES.includes(next)) return language;
    language = next;
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Ignore storage failures.
    }
    await writeServerLanguage(next);
    applyI18n();
    document.documentElement.lang = next;
    window.dispatchEvent(new CustomEvent("chatlume:languagechange", { detail: { language: next } }));
    return language;
}
