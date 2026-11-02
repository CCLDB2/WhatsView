/**
 * ============================================================================
 * Language switch for the static pages
 * ============================================================================
 * index.html and friends load js/site.js as a classic script, so they cannot
 * import the ES module that owns translations. This module is the bridge: it
 * applies the hooks, exposes t() on `window.chatLumeI18n` for site.js's
 * generated copy, and wires the small language button in the landing nav.
 *
 * The choice is the same one the viewer writes, so switching here and opening
 * the viewer keeps the same language (subject to the server's stored value).
 * ============================================================================
 */
import { applyI18n, getLanguage, initI18n, setLanguage, t } from "./i18n.js?v=1.8.28";

const nextLanguage = (language) => (language === "es" ? "en" : "es");
const languageLabel = (language) => (language === "es" ? "EN" : "ES");

function syncToggles() {
    const language = getLanguage();
    document.querySelectorAll("[data-language-toggle-label]").forEach((element) => {
        element.textContent = languageLabel(language);
    });
    document.querySelectorAll("[data-language-toggle]").forEach((element) => {
        // The button offers the language you are *not* reading.
        element.setAttribute("title", nextLanguage(language) === "es"
            ? t("Cambiar a español")
            : t("Cambiar a inglés"));
    });
}

function bindToggles() {
    document.querySelectorAll("[data-language-toggle]").forEach((element) => {
        element.addEventListener("click", async () => {
            await setLanguage(nextLanguage(getLanguage()));
            location.reload();
        });
    });
}

window.chatLumeI18n = { applyI18n, getLanguage, setLanguage, t };

bindToggles();
applyI18n();
syncToggles();
initI18n().then(() => {
    applyI18n();
    syncToggles();
    // Classic scripts may have rendered before this module loaded, in which
    // case their t() bridge call fell back to the Spanish source text. Tell
    // them the translator (and the final language) is ready now.
    window.dispatchEvent(new CustomEvent("chatlume:languagechange", { detail: { language: getLanguage() } }));
});
