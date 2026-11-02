import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { versioned } from "./versioned.mjs";

/**
 * What "search finds it" means. These are the promises the toolbar makes to
 * the reader, so each one is pinned: a query matches anywhere in the message,
 * ignoring case, accents and whitespace runs; the highlight uses the same
 * rule, so a result never lands on a row with nothing marked; and everything
 * the result list looks at is something the row actually shows.
 */
const { foldSearchText, matchesSearch, searchPatternSource } = await versioned("../js/shared/search-text.js");
const { findMessageSearchResults, messageSearchFields, missingMediaLabel, nextSearchIndex } = await versioned("../js/shared/search-index.js");

const message = (overrides) => ({
    type: "msg",
    id: "m1",
    sender: "Ana",
    text: "",
    mediaItems: [],
    reactions: [],
    ...overrides
});

describe("search/accents, case and spacing", () => {
    test("foldSearchText lowercases, strips accents and collapses spacing", () => {
        assert.equal(foldSearchText("  Canción   de  Cuna "), "cancion de cuna");
        assert.equal(foldSearchText("CAMION"), "camion");
        assert.equal(foldSearchText(null), "");
        assert.equal(foldSearchText(undefined), "");
    });

    test("a query without accents finds the accented message", () => {
        assert.equal(matchesSearch("Canción de cuna", "cancion"), true);
        assert.equal(matchesSearch("Canción de cuna", "CANCIÓN"), true);
        assert.equal(matchesSearch("camión", "camion"), true);
        assert.equal(matchesSearch("Añadir", "anadir"), true);
    });

    test("a query with accents finds the plain spelling too", () => {
        assert.equal(matchesSearch("cancion", "canción"), true);
    });

    test("whitespace runs and edge spaces are not significant", () => {
        assert.equal(matchesSearch("hola   mundo", "hola mundo"), true);
        assert.equal(matchesSearch("hola mundo", "  hola   mundo  "), true);
    });

    test("accents are folded, not guessed: different letters still differ", () => {
        assert.equal(matchesSearch("camión", "canion"), false);
        assert.equal(matchesSearch("hola", "holas"), false);
        assert.equal(matchesSearch("casa", ""), false);
    });

    test("the pattern matches the accented text, and stays regex-safe", () => {
        const pattern = (query) => new RegExp(searchPatternSource(query), "giu");
        assert.equal(pattern("cancion").test("Canción"), true);
        assert.equal(pattern("a.b").test("a.b"), true);
        assert.equal(pattern("a.b").test("axb"), false);
        assert.equal(pattern("(x)").test("(x)"), true);
    });
});

describe("search/what a message can be found by", () => {
    test("sender, text, attachment names, shares and reactions", () => {
        const entry = message({
            sender: "Ravi",
            text: "Shared weekend plans",
            mediaItems: [{ name: "photo.jpg" }],
            shareText: "Dinner idea",
            shareLink: "https://example.test/post",
            reactions: [{ reaction: "👍", actor: "Bob" }]
        });
        for (const query of ["ravi", "weekend", "photo.jpg", "dinner idea", "example.test", "bob", "👍"]) {
            assert.deepEqual(findMessageSearchResults([entry], query), ["m1"], query);
        }
        assert.deepEqual(findMessageSearchResults([entry], "absent"), []);
    });

    test("a missing attachment is findable by the label the row shows", () => {
        // The file was never exported, so the row displays the translated
        // stand-in. Searching "multimedia omitido" used to find nothing; now
        // the raw "Media omitted" token is not indexed at all, because nothing
        // on screen says it — a hit without a highlight looks like a bug.
        const entry = message({ mediaItems: [{ status: "missing", name: "Media omitted" }] });
        assert.deepEqual(findMessageSearchResults([entry], "multimedia omitido"), ["m1"]);
        assert.deepEqual(findMessageSearchResults([entry], "media omitted"), []);
        assert.equal(missingMediaLabel("Media omitted"), "Multimedia omitido");
        assert.equal(missingMediaLabel(""), "Archivo adjunto faltante");
    });

    test("a named attachment missing from the export keeps its own name", () => {
        const entry = message({ mediaItems: [{ status: "missing", name: "contrato.pdf" }] });
        assert.deepEqual(findMessageSearchResults([entry], "contrato"), ["m1"]);
        assert.deepEqual(findMessageSearchResults([entry], "multimedia omitido"), []);
    });

    test("everything indexed is something the row renders", () => {
        // Guard against the general form of the bug above: every field must
        // appear on screen, so every hit can be highlighted.
        const entry = message({
            sender: "Ravi",
            text: "hola",
            mediaItems: [{ status: "missing", name: "Media omitted" }, { name: "foto.jpg" }],
            reactions: [{ reaction: "👍", actor: "Bob" }]
        });
        const rendered = `${entry.sender} ${entry.text} foto.jpg ${missingMediaLabel("Media omitted")} 👍 Bob`;
        for (const field of messageSearchFields(entry)) {
            assert.ok(rendered.includes(field), `not rendered: ${field}`);
        }
    });

    test("only messages are searched, and an empty query matches nothing", () => {
        const entries = [
            { type: "date", id: "d1", content: "1 de enero" },
            { type: "system", id: "s1", content: "Los mensajes están cifrados" },
            message({ id: "m1", text: "hola" })
        ];
        assert.deepEqual(findMessageSearchResults(entries, "enero"), []);
        assert.deepEqual(findMessageSearchResults(entries, "cifrados"), []);
        assert.deepEqual(findMessageSearchResults(entries, "   "), []);
        assert.deepEqual(findMessageSearchResults(entries, ""), []);
    });

    test("a media kind label is not a match", () => {
        // Searching "documento" returning every document would be chrome noise.
        const entry = message({ mediaItems: [{ name: "informe.pdf", kind: "document" }] });
        assert.deepEqual(findMessageSearchResults([entry], "documento"), []);
        assert.deepEqual(findMessageSearchResults([entry], "informe"), ["m1"]);
    });

    test("a message missing mediaItems cannot break the whole search", () => {
        const broken = { type: "msg", id: "m1", sender: "Ana", text: "hola" };
        assert.deepEqual(findMessageSearchResults([broken], "hola"), ["m1"]);
        assert.deepEqual(messageSearchFields(null), []);
    });

    test("the label a missing attachment is found by follows the interface language", async () => {
        // The row shows the translated stand-in, so the index has to agree with
        // it: whichever language is active, the label on screen is the label
        // that finds the message. i18n's setter expects a browser, so a stub
        // stands in for the parts it touches.
        const previousWindow = globalThis.window;
        const previousDocument = globalThis.document;
        globalThis.window = {
            location: { protocol: "file:" },
            dispatchEvent() {}
        };
        globalThis.document = { documentElement: {}, querySelectorAll: () => [] };

        const i18n = await versioned("../js/i18n.js");
        const entry = message({ mediaItems: [{ status: "missing", name: "Media omitted" }] });
        try {
            await i18n.setLanguage("es");
            assert.equal(missingMediaLabel("Media omitted"), "Multimedia omitido");
            assert.deepEqual(findMessageSearchResults([entry], "multimedia omitido"), ["m1"]);
            assert.deepEqual(findMessageSearchResults([entry], "media omitted"), []);

            await i18n.setLanguage("en");
            assert.equal(missingMediaLabel("Media omitted"), "Media omitted");
            assert.deepEqual(findMessageSearchResults([entry], "media omitted"), ["m1"]);
            assert.deepEqual(findMessageSearchResults([entry], "multimedia omitido"), []);

            await i18n.setLanguage("es");
        } finally {
            globalThis.window = previousWindow;
            globalThis.document = previousDocument;
        }
    });

    test("navigation wraps at both ends", () => {
        assert.equal(nextSearchIndex(0, 3, "up"), 2);
        assert.equal(nextSearchIndex(2, 3, "down"), 0);
        assert.equal(nextSearchIndex(0, 0, "down"), -1);
    });
});

describe("search/both viewers share one rule", () => {
    test("the Instagram model re-exports the shared implementation", async () => {
        const instagram = await versioned("../js/instagram/search-model.js");
        assert.equal(instagram.findMessageSearchResults, findMessageSearchResults);
        assert.equal(instagram.nextSearchIndex, nextSearchIndex);
    });

    test("the WhatsApp toolbar no longer keeps a second copy of the predicate", async () => {
        const { readFileSync } = await import("node:fs");
        const source = readFileSync(new URL("../js/whatsapp/search.js", import.meta.url), "utf8");
        assert.doesNotMatch(source, /function getSearchableText/,
            "the predicate lives in shared/search-index.js");
        assert.match(source, /findMessageSearchResults\(/);
    });

    test("the empty-result counter is translated in both viewers", async () => {
        const { readFileSync } = await import("node:fs");
        for (const page of ["../js/whatsapp/search.js", "../js/instagram/search.js"]) {
            const source = readFileSync(new URL(page, import.meta.url), "utf8");
            assert.match(source, /t\("Sin resultados"\)/, `${page} translates the empty counter`);
            assert.doesNotMatch(source, /updateSearchCounter\("No matches"\)/, page);
        }
    });
});
