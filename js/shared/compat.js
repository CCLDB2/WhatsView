/**
 * ============================================================================
 * Browser capability checks
 * ============================================================================
 * Exports over 1 GB are only safe to open when the browser can stream ZIP
 * entries (DecompressionStream + WritableStream + TextDecoderStream). Older
 * browsers still work, but with a hard file-size cap and a banner saying so.
 * ============================================================================
 */

import { t } from "../i18n.js?v=1.8.25";

export const SUPPORTS_STREAMING =
    typeof DecompressionStream !== "undefined" &&
    typeof WritableStream !== "undefined" &&
    typeof TextDecoderStream !== "undefined";

/** 1 GB cap for browsers without the streaming APIs. */
export const COMPAT_FILE_SIZE_LIMIT = 1 * 1024 * 1024 * 1024;

const BROWSER_HINT = "Chrome 80+, Firefox 79+ o Safari 16.4+";

/** Shown when a picked or dropped file is over the cap. */
export const COMPAT_LIMIT_MESSAGE = t("El archivo supera el límite de 1 GB para tu navegador. Usa {browsers} para archivos más grandes.", { browsers: BROWSER_HINT });

/** Shown when the user tries to *load* a file that is over the cap. */
export function fileTooLargeMessage(file) {
    return t("El archivo es demasiado grande para tu navegador ({size} GB). Usa {browsers} para archivos de más de 1 GB.", {
        size: (file.size / 1073741824).toFixed(1),
        browsers: BROWSER_HINT
    });
}

/** True when this browser cannot open `file` without streaming support. */
export function exceedsCompatLimit(file) {
    return !SUPPORTS_STREAMING && file.size > COMPAT_FILE_SIZE_LIMIT;
}

/** Inserts the limited-support banner under the app nav on old browsers. */
export function showCompatBannerIfNeeded() {
    if (SUPPORTS_STREAMING) return;
    const nav = document.querySelector("nav.app-nav");
    const banner = document.createElement("div");
    banner.id = "compat-banner";
    banner.setAttribute("role", "alert");
    banner.style.cssText = "background:#7c5c00;color:#fef3c7;padding:8px 16px;font-size:13px;text-align:center;position:sticky;top:0;z-index:999;line-height:1.5";
    banner.textContent = t("⚠️ Tu navegador tiene compatibilidad limitada. Los archivos de más de 1 GB pueden no cargarse. Usa {browsers}.", { browsers: "Chrome 80+, Firefox 79+ o Safari 16.4+" });
    if (nav?.parentNode) {
        nav.parentNode.insertBefore(banner, nav.nextSibling);
    } else {
        document.body.prepend(banner);
    }
}
