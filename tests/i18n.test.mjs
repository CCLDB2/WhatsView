import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * Spanish is the source language: the dictionary's keys are the exact Spanish
 * strings the UI renders. A key that no hook or t() call can produce is dead
 * weight; a Spanish string with no English entry silently renders in Spanish
 * for English users. Both are release bugs, so both are tested.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

const DICTIONARY = read("js/i18n-dictionary.js");
const HOOKS = read("js/i18n.js");

/** Pages that carry translation hooks. */
const PAGES = [
    "index.html",
    "sponsors.html",
    "privacy.html",
    "public/viewer.html",
    "public/instagram-viewer.html",
    "public/404.html",
    "public/how-it-works.html",
    "public/how-to-use.html",
    "public/how-to-export.html",
    "public/how-to-export-instagram.html"
];

function listJs(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = resolve(dir, name);
        if (statSync(path).isDirectory()) return listJs(path);
        return name.endsWith(".js") ? [path.slice(root.length + 1).split("\\").join("/")] : [];
    });
}

/** Every `"spanish": "english",` pair in the dictionary, in order. */
function dictionaryEntries() {
    return [...DICTIONARY.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/gm)]
        .map((match) => ({ source: JSON.parse(`"${match[1]}"`), target: JSON.parse(`"${match[2]}"`) }));
}

function decodeEntities(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/** Source strings the UI can actually ask for. */
function usedSourceStrings() {
    const used = new Set();

    for (const page of PAGES) {
        const html = read(page);
        for (const match of html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label|-alt)?="([^"]*)"/g)) {
            used.add(decodeEntities(match[1]));
        }
    }

    for (const file of listJs(resolve(root, "js"))) {
        if (file === "js/i18n-dictionary.js") continue;
        const source = read(file);
        for (const match of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
            used.add(JSON.parse(`"${match[1]}"`));
        }
        for (const match of source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
            used.add(match[1]);
        }
    }

    return used;
}

describe("interface translations", () => {
    const entries = dictionaryEntries();

    test("Spanish is the default language and English is the only translation", () => {
        const i18n = read("js/i18n.js");
        assert.match(i18n, /DEFAULT_LANGUAGE = "es"/);
        assert.match(i18n, /SUPPORTED_LANGUAGES = Object\.freeze\(\["es", "en"\]\)/);
        assert.match(read("public/viewer.html"), /<html lang="es">/);
    });

    test("every translation hook type is applied", () => {
        for (const hook of ["data-i18n", "data-i18n-html", "data-i18n-placeholder", "data-i18n-title", "data-i18n-aria-label", "data-i18n-alt"]) {
            assert.ok(HOOKS.includes(`[${hook}]`), `${hook} is not applied by applyI18n`);
        }
    });

    test("the dictionary has no duplicate keys", () => {
        const seen = new Set();
        for (const { source } of entries) {
            assert.equal(seen.has(source), false, `duplicate key: ${source}`);
            seen.add(source);
        }
    });

    test("every string the UI renders has an English translation", () => {
        const sources = new Set(entries.map((entry) => entry.source));
        const missing = [...usedSourceStrings()].filter((source) => !sources.has(source));
        assert.deepEqual(missing, [], `missing EN entries: ${missing.join(", ")}`);
    });

    test("every dictionary key is actually reachable from the UI", () => {
        // Media kinds and the stats noun are looked up dynamically rather than
        // through a literal t("…") call.
        const dynamic = new Set([
            "chat", "conversación",
            "Imagen", "Pegatina", "Vídeo", "Audio", "Documento", "Archivo comprimido", "Contacto", "Archivo"
        ]);
        const used = usedSourceStrings();
        const unused = entries
            .map((entry) => entry.source)
            .filter((source) => !used.has(source) && !dynamic.has(source));
        assert.deepEqual(unused, [], `unused dictionary keys: ${unused.join(", ")}`);
    });

    test("placeholders in a translation match the Spanish source", () => {
        const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const { source, target } of entries) {
            assert.deepEqual(placeholders(target), placeholders(source), `placeholders differ: ${source}`);
        }
    });
});
