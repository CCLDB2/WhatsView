import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { versioned } from "./versioned.mjs";

const { exportChatAsHTML } = await versioned("../js/export.js");

async function captureExport(options) {
    const previousDocument = globalThis.document;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    const originalSetTimeout = globalThis.setTimeout;
    let capturedBlob;
    globalThis.document = {
        createElement: () => ({ style: {}, click() {} }),
        body: { appendChild() {}, removeChild() {} }
    };
    URL.createObjectURL = (blob) => {
        capturedBlob = blob;
        return "blob:chatlume-test";
    };
    URL.revokeObjectURL = () => {};
    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };

    try {
        exportChatAsHTML(options);
        return await capturedBlob.text();
    } finally {
        globalThis.document = previousDocument;
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
        globalThis.setTimeout = originalSetTimeout;
    }
}

describe("HTML export", () => {
    test("preserves all messages and metadata when no sender filter is active", async () => {
        const html = await captureExport({
            title: "Family Chat",
            messageCount: 2,
            messages: [
                { type: "date", label: "Jan 1, 2024" },
                { type: "system", text: "Alice added Bob" },
                { type: "msg", sender: "Alice", text: "Hello" },
                { type: "msg", sender: "Bob", text: "Hi" }
            ]
        });

        assert.match(html, /ChatLume Export — Family Chat/);
        assert.match(html, /2 messages/);
        assert.match(html, /Alice added Bob/);
        assert.match(html, /Hello/);
        assert.match(html, /Hi/);
    });

    test("exports only the selected participants with accurate title and count", async () => {
        const html = await captureExport({
            title: "Project (2 participants)",
            messageCount: 2,
            messages: [
                { type: "date", label: "Jan 1, 2024" },
                { type: "msg", sender: "Alice", text: "Ready" },
                { type: "msg", sender: "Ravi", text: "Go" }
            ]
        });

        assert.match(html, /ChatLume Export — Project \(2 participants\)/);
        assert.match(html, /2 messages/);
        assert.match(html, /Ready/);
        assert.match(html, /Go/);
        assert.doesNotMatch(html, /Bob|excluded message/);
    });

    test("the language is baked into the document, not resolved when it is opened", async () => {
        const html = await captureExport({
            title: "Familia",
            messageCount: 2,
            language: "es",
            messages: [
                { type: "date", label: "1 ene 2024" },
                { type: "msg", sender: "Ana", text: "Hola" }
            ]
        });

        // Whoever opens the file has no selector and no server preference, so
        // both the machine-readable tag and the visible labels must be Spanish.
        assert.match(html, /<html lang="es">/);
        assert.match(html, /Exportación de ChatLume — Familia/);
        assert.match(html, /2 mensajes/);
        assert.match(html, /Los archivos multimedia no se incluyen en esta exportación/);
        assert.match(html, /💬 Exportación de ChatLume/);
        assert.doesNotMatch(html, /2 messages|ChatLume Export/);
        // Chat content is never translated.
        assert.match(html, /Hola/);
        assert.match(html, /Ana/);
    });

    test("English is explicit and Spanish is the fallback for an unknown language", async () => {
        const english = await captureExport({ title: "Chat", messageCount: 1, language: "en", messages: [] });
        assert.match(english, /<html lang="en">/);
        assert.match(english, /1 message</);
        assert.doesNotMatch(english, /1 messages/);

        const spanish = await captureExport({ title: "Chat", messageCount: 1, language: "es", messages: [] });
        assert.match(spanish, /1 mensaje</);
        assert.doesNotMatch(spanish, /1 mensajes/);

        const unknown = await captureExport({ title: "Chat", messageCount: 1, language: "fr", messages: [] });
        assert.match(unknown, /<html lang="en">/);
        assert.match(unknown, /Los archivos multimedia no se incluyen|Media files are not included/);
    });

    test("media kind labels follow the selected language", async () => {
        const html = await captureExport({
            title: "Chat",
            messageCount: 1,
            language: "es",
            messages: [{
                type: "msg",
                sender: "Ana",
                text: "",
                media: [{ kind: "document", name: "informe.pdf" }]
            }]
        });

        assert.match(html, /Documento/);
        assert.doesNotMatch(html, /Document\b/);
        // The attachment's own name is user data and stays untouched.
        assert.match(html, /informe\.pdf/);
    });

    test("the download link and the attachments notice are localised too", async () => {
        // Packaging attachments pulls zip.js from a CDN, which a unit test
        // cannot fetch; assert the wiring instead of the packaged output.
        const source = readFileSync(new URL("../js/export.js", import.meta.url), "utf8");
        assert.match(source, /download>\$\{escapeHtml\(lang\.downloadAttachment\)\}<\/a>/,
            "the download link uses the localised string");
        assert.match(source, /lang\.attachmentsIncluded\(/, "the attachments notice is localised");
        assert.match(source, /\bSTRINGS\b/, "both languages live in one table");
        // The folder name is the only inline code; the count is plain text. A
        // helper that wraps both produced a stray <code>60</code>.
        assert.equal(source.match(/<code>attachments<\/code>/g)?.length, 2,
            "both languages wrap only the folder name in <code>");
        assert.doesNotMatch(source, /<code>\$\{count\}<\/code>/);
        // Every English UI string must live in the table, not in the markup.
        const markup = source.slice(source.indexOf("function buildExportDocument"));
        assert.doesNotMatch(markup, /Download attachment/);
        assert.doesNotMatch(markup, /Media files are not included/);
    });

    test("both viewers hand their current language to the exporter", async () => {
        for (const path of ["../js/whatsapp/session.js", "../js/instagram/session.js"]) {
            const source = readFileSync(new URL(path, import.meta.url), "utf8");
            assert.match(source, /import \{[^}]*\bgetLanguage\b[^}]*\} from "\.\.\/i18n\.js\?v=/,
                `${path} imports getLanguage`);
            assert.match(source, /await exportChatAsHTML\(\{[\s\S]*?language: getLanguage\(\)/,
                `${path} bakes the active language into the export`);
        }
    });
});
