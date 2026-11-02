/**
 * ============================================================================
 * Search normalisation
 * ============================================================================
 * A query matches a message when it appears anywhere in that message's
 * searchable text, ignoring case, combining diacritics and runs of whitespace:
 * "cancion" finds "canción" and "hola mundo" finds "hola   mundo".
 *
 * Highlighting needs the opposite direction — turning a typed query back into
 * a pattern that matches the characters actually on screen — so both sides are
 * derived from the same fold. Otherwise a message can be found without the
 * match ever being visible, which is exactly what used to happen with accents.
 *
 * Pure functions, covered by tests/shared.test.mjs.
 * ============================================================================
 */
import { escapeRegExp } from "./dom.js?v=1.8.28";

const DIACRITICS = /\p{M}+/gu;

/** Case- and accent-folded form of a single character. */
function foldChar(char) {
    return char.toLowerCase().normalize("NFD").replace(DIACRITICS, "");
}

/**
 * Letters that fold to the same base letter, keyed by that base.
 *
 * Built by folding the accented Unicode blocks ourselves rather than pasting a
 * table, so the set can never drift from foldChar(). Only single-letter folds
 * that land on a-z qualify: ligatures (æ, ß) are distinct letters, not
 * accents, and stay exact.
 */
const ACCENT_VARIANTS = (() => {
    const byBase = new Map();
    for (const [start, end] of [[0x00c0, 0x024f], [0x1e00, 0x1eff]]) {
        for (let code = start; code <= end; code += 1) {
            const letter = String.fromCodePoint(code);
            if (!/\p{L}/u.test(letter)) continue;
            const base = foldChar(letter);
            if (base.length !== 1 || !/[a-z]/.test(base)) continue;
            if (!byBase.has(base)) byBase.set(base, []);
            const variants = byBase.get(base);
            if (!variants.includes(letter)) variants.push(letter);
        }
    }
    return byBase;
})();

/**
 * Lowercase, accent-free, single-spaced form used for every comparison.
 * Accepts user data (a message, a filename) as well as a typed query.
 */
export function foldSearchText(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(DIACRITICS, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** True when `query` appears anywhere in `haystack`, ignoring case/accents. */
export function matchesSearch(haystack, query) {
    const needle = foldSearchText(query);
    return Boolean(needle) && foldSearchText(haystack).includes(needle);
}

/** One query character as a class holding its accented twins. */
function classFor(char) {
    const base = foldChar(char);
    // Trailing combining marks belong to the character they sit on: without
    // them, decomposed text highlights the letter and leaves the accent behind.
    const marks = "\\p{M}*";
    const variants = ACCENT_VARIANTS.get(base);
    if (!variants) return escapeRegExp(char) + marks;
    const letters = [base, ...variants].map((letter) => letter.replace(/[\\\]^-]/g, "\\$&"));
    return `[${letters.join("")}]${marks}`;
}

const SOURCE_CACHE = new Map();
const SOURCE_CACHE_LIMIT = 16;

/**
 * RegExp source that matches the query as it is written on screen.
 *
 * Highlighting runs once per visible row, so the built source is cached by
 * query: rebuilding a few hundred character classes per bubble is pure waste.
 */
export function searchPatternSource(query) {
    const normalized = String(query ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    const cached = SOURCE_CACHE.get(normalized);
    if (cached) return cached;

    let source = "";
    for (const char of normalized) {
        source += /\s/.test(char) ? "\\s+" : classFor(char);
    }

    if (SOURCE_CACHE.size >= SOURCE_CACHE_LIMIT) SOURCE_CACHE.clear();
    SOURCE_CACHE.set(normalized, source);
    return source;
}

/** Fresh global pattern for the current query, or null when it is empty. */
export function searchPattern(query) {
    const source = searchPatternSource(query);
    return source ? new RegExp(source, "giu") : null;
}
