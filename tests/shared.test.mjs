import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { versioned } from "./versioned.mjs";

const { escapeAttribute, escapeHtml, escapeRegExp } = await versioned("../js/shared/dom.js");
const { applyTextFormatting, buildRichText, highlightOutsideTags } = await versioned("../js/shared/text.js");
const { baseName, detectMediaType, formatBytes, inferMimeType, labelForMediaKind } = await versioned("../js/shared/media-types.js");
const { SENDER_COLORS, colorForName } = await versioned("../js/shared/colors.js");
const { countEmojis } = await versioned("../js/shared/emoji.js");
const { clampRenderRange, fallbackScrollTop, getScrollAnchor, isAtConversationEnd, isSavedPositionAtConversationEnd, paginateOnScroll, restoreScrollAnchor, settleAnchorOffset, syncScrollLatestButton, tailRange } = await versioned("../js/shared/virtual-list.js");
const { compensatingScrollShift, mediaRatioFrom, mediaRatioStyle } = await versioned("../js/shared/lazy-media.js");

/**
 * The utilities both viewers share. These used to be duplicated (with small
 * drifts) in script.js and instagram.js; now there is one copy, and it is
 * pinned here.
 */

describe("shared/dom escaping", () => {
    test("escapeHtml neutralises every HTML-significant character", () => {
        assert.equal(escapeHtml(`<a href="x">it's & more</a>`), "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; more&lt;/a&gt;");
    });

    test("escapeAttribute also neutralises backticks", () => {
        assert.equal(escapeAttribute("`x`"), "&#96;x&#96;");
    });

    test("escapeRegExp makes a literal pattern", () => {
        assert.equal(new RegExp(escapeRegExp("a.b*c?")).test("a.b*c?"), true);
        assert.equal(new RegExp(escapeRegExp("a.b*c?")).test("aXbc"), false);
    });
});

describe("shared/text", () => {
    test("applies WhatsApp *bold* _italic_ ~strike~ markers", () => {
        assert.equal(applyTextFormatting("*b* _i_ ~s~"), "<strong>b</strong> <em>i</em> <s>s</s>");
    });

    test("linkifies URLs without letting formatting rewrite the href", () => {
        const html = buildRichText("see https://example.com/Foo_bar_baz _now_");
        assert.match(html, /href="https:\/\/example\.com\/Foo_bar_baz"/);
        assert.match(html, /<em>now<\/em>/);
        assert.doesNotMatch(html, /Foo<em>/);
    });

    test("formatting can be switched off (Instagram has no markers)", () => {
        assert.equal(buildRichText("*not bold* https://x.y", { formatting: false }),
            '*not bold* <a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a>');
    });

    test("highlightOutsideTags never touches attributes", () => {
        const html = highlightOutsideTags('<a href="http://a">http://a</a>', "http");
        assert.equal(html, '<a href="http://a"><span class="hl">http</span>://a</a>');
    });

    test("highlight is case-insensitive and regex-safe", () => {
        assert.equal(highlightOutsideTags("A.b a.B", "a.b"), '<span class="hl">A.b</span> <span class="hl">a.B</span>');
        assert.equal(highlightOutsideTags("axb", "a.b"), "axb");
    });

    test("the highlight folds accents exactly like the result list does", () => {
        // A query without accents must still mark the accented text it found,
        // and a query with accents must match the plain spelling.
        assert.equal(highlightOutsideTags("Canción de cuna", "cancion"),
            '<span class="hl">Canción</span> de cuna');
        assert.equal(highlightOutsideTags("cancion", "canción"),
            '<span class="hl">cancion</span>');
        assert.equal(highlightOutsideTags("camión", "camion"), '<span class="hl">camión</span>');
        // Decomposed text keeps its accent inside the highlighted run.
        const decomposed = "cancio\u0301n";
        assert.equal(highlightOutsideTags(decomposed, "cancion"),
            '<span class="hl">cancio\u0301n</span>');
    });

    test("the highlight collapses whitespace runs, like the match", () => {
        assert.equal(highlightOutsideTags("hola   mundo", "hola mundo"),
            '<span class="hl">hola   mundo</span>');
    });

    test("an empty query leaves the html untouched", () => {
        assert.equal(highlightOutsideTags("hola", ""), "hola");
        assert.equal(highlightOutsideTags("hola", "   "), "hola");
    });
});

describe("shared/media-types", () => {
    test("voice-note extensions are always audio, whatever the MIME says", () => {
        assert.deepEqual(detectMediaType("PTT-1.opus"), { kind: "audio", mime: "audio/ogg", ext: "opus" });
        assert.equal(detectMediaType("clip.m4a", { mimeType: "video/mp4" }).kind, "audio");
        assert.equal(detectMediaType("song.flac").mime, "audio/flac");
    });

    test("WhatsApp stickers are detected by extension or STK- prefix", () => {
        assert.equal(detectMediaType("STK-20240101-WA0001.webp").kind, "sticker");
        assert.equal(detectMediaType("photo.webp").kind, "sticker");
        assert.equal(detectMediaType("IMG-1.jpg").kind, "image");
    });

    test("Instagram opts out of sticker detection so .webp photos stay images", () => {
        assert.equal(detectMediaType("photo.webp", { stickers: false }).kind, "image");
        assert.equal(detectMediaType("STK-1.webp", { stickers: false }).kind, "image");
    });

    test("documents, archives and contacts get their own kinds", () => {
        assert.equal(detectMediaType("notes.pdf").kind, "document");
        assert.equal(detectMediaType("backup.zip").kind, "archive");
        assert.equal(detectMediaType("me.vcf").kind, "contact");
        assert.equal(detectMediaType("whatever.xyz").kind, "document");
        assert.equal(detectMediaType("clip.mov").kind, "video");
    });

    test("inferMimeType falls back to octet-stream", () => {
        assert.equal(inferMimeType("png"), "image/png");
        assert.equal(inferMimeType("nope"), "application/octet-stream");
    });

    test("labelForMediaKind and formatBytes", () => {
        assert.equal(labelForMediaKind("sticker"), "Sticker");
        assert.equal(labelForMediaKind("missing"), "File");
        assert.equal(formatBytes(0), "");
        assert.equal(formatBytes(512), "512 B");
        assert.equal(formatBytes(1536), "1.5 KB");
        assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
        assert.equal(formatBytes(3 * 1024 ** 4), "3072 GB");
    });

    test("baseName takes the last path segment", () => {
        assert.equal(baseName("messages/inbox/x/photos/a.jpg"), "a.jpg");
        assert.equal(baseName(""), "");
    });
});

describe("shared/colors", () => {
    test("colours are stable per name and memoised", () => {
        const map = {};
        const first = colorForName("Alice", map);
        assert.ok(SENDER_COLORS.includes(first));
        assert.equal(colorForName("Alice", map), first);
        assert.equal(colorForName("Alice", {}), first);
        assert.equal(Object.keys(map).length, 1);
    });
});

describe("shared/emoji", () => {
    test("counts emojis into the tally", () => {
        const stats = {};
        countEmojis("hi 😀😀 🎉 no emoji here", stats);
        countEmojis("😀", stats);
        assert.deepEqual(stats, { "😀": 3, "🎉": 1 });
    });
});

describe("shared/virtual-list", () => {
    test("tailRange shows the newest window", () => {
        assert.deepEqual(tailRange(1000, 180), { start: 820, end: 1000 });
        assert.deepEqual(tailRange(50, 180), { start: 0, end: 50 });
    });

    test("clampRenderRange keeps the window inside the list and under the cap", () => {
        const state = { filteredMessages: new Array(100), renderRange: { start: -5, end: 500 } };
        clampRenderRange(state, 30);
        assert.deepEqual(state.renderRange, { start: 70, end: 100 });

        state.renderRange = { start: 90, end: 20 };
        clampRenderRange(state, 30);
        assert.deepEqual(state.renderRange, { start: 90, end: 90 });
    });

    test("does not treat the bottom of a virtual window as the end of the full chat", () => {
        const viewport = { scrollHeight: 800, scrollTop: 480, clientHeight: 320 };
        const partial = { filteredMessages: new Array(1000), renderRange: { start: 200, end: 380 } };
        const complete = { ...partial, renderRange: { start: 820, end: 1000 } };
        assert.equal(isAtConversationEnd(viewport, partial), false);
        assert.equal(isAtConversationEnd(viewport, complete), true);
    });

    test("rejects stale bottom flags anchored in the middle of a chat", () => {
        const messages = Array.from({ length: 1000 }, (_, index) => ({ id: `msg-${index}` }));
        assert.equal(isSavedPositionAtConversationEnd({ atBottom: true, messageId: "msg-300" }, messages, 180), false);
        assert.equal(isSavedPositionAtConversationEnd({ atBottom: true, messageId: "msg-900" }, messages, 180), true);
        assert.equal(isSavedPositionAtConversationEnd({ atBottom: false, messageId: "msg-900" }, messages, 180), false);
    });

    test("keeps re-correcting an anchor until the rows above it stop growing", () => {
        let rowTop = 100;
        let scrollTop = 0;
        const viewport = {
            get scrollTop() { return scrollTop; },
            set scrollTop(value) { scrollTop = value; rowTop -= value - (viewport.__last ?? value); viewport.__last = value; },
            getBoundingClientRect: () => ({ top: 0 })
        };
        viewport.__last = 0;
        const element = { getBoundingClientRect: () => ({ top: rowTop }) };

        // A photo above the row finishes decoding after the first frame.
        const frames = [];
        const originalRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = (callback) => frames.push(callback);
        try {
            settleAnchorOffset(viewport, () => element, 0, 6);
            frames.splice(0).forEach((callback) => callback());
            assert.equal(rowTop, 0, "the first frame puts the row in place");

            rowTop += 14; // the late photo pushes everything below it down
            frames.splice(0).forEach((callback) => callback());
            assert.equal(rowTop, 0, "the next frame absorbs the late growth");
        } finally {
            if (originalRaf) globalThis.requestAnimationFrame = originalRaf;
            else delete globalThis.requestAnimationFrame;
        }
    });

    test("does not show jump-to-latest from a stale animation frame", () => {
        const originalRaf = globalThis.requestAnimationFrame;
        const originalWindow = globalThis.window;
        const frames = [];
        globalThis.requestAnimationFrame = (callback) => frames.push(callback);
        globalThis.window = { setTimeout: () => 0 };
        const classes = new Set();
        const button = {
            hidden: true,
            classList: {
                add: (name) => classes.add(name),
                remove: (name) => classes.delete(name),
                contains: (name) => classes.has(name)
            }
        };
        const viewport = { scrollHeight: 1000, scrollTop: 300, clientHeight: 300 };
        const state = { filteredMessages: new Array(10), renderRange: { start: 0, end: 10 } };

        try {
            syncScrollLatestButton(button, viewport, state);
            syncScrollLatestButton(button, viewport, state);
            assert.equal(frames.length, 1);
            viewport.scrollTop = 700;
            syncScrollLatestButton(button, viewport, state);
            frames.forEach((callback) => callback());
            assert.equal(classes.has("show"), false);
        } finally {
            if (originalRaf) globalThis.requestAnimationFrame = originalRaf;
            else delete globalThis.requestAnimationFrame;
            if (originalWindow) globalThis.window = originalWindow;
            else delete globalThis.window;
        }
    });
});

/**
 * A scroll viewport whose rows can be replaced the way `innerHTML = html`
 * replaces them, so paging can be tested without a browser.
 */
function createScrollHarness(ids, { clientHeight = 320, rowHeight = 60, viewportTop = 100 } = {}) {
    let rows = ids.map((id) => ({ id, height: rowHeight }));
    let elements = new Map();

    const viewport = {
        scrollTop: 0,
        clientHeight,
        get scrollHeight() {
            return rows.reduce((total, row) => total + row.height, 0);
        },
        getBoundingClientRect: () => ({ top: viewportTop, bottom: viewportTop + clientHeight }),
        querySelectorAll: () => [...elements.values()]
    };

    function rectOf(row) {
        let top = viewportTop - viewport.scrollTop;
        for (const candidate of rows) {
            if (candidate === row) break;
            top += candidate.height;
        }
        return { top, bottom: top + row.height };
    }

    function mount() {
        elements = new Map(rows.map((row) => [row.id, {
            id: row.id,
            isConnected: true,
            getBoundingClientRect: () => rectOf(row)
        }]));
    }

    /** Replaces the DOM, as a render does: old nodes disconnect, new ones mount. */
    function render(before = [], after = [], { replace = false } = {}) {
        elements.forEach((element) => { element.isConnected = false; });
        const kept = replace ? [] : rows;
        rows = [
            ...before.map((id) => ({ id, height: rowHeight })),
            ...kept,
            ...after.map((id) => ({ id, height: rowHeight }))
        ];
        mount();
    }

    function offsetOf(id) {
        const element = elements.get(id);
        return element ? element.getBoundingClientRect().top - viewportTop : null;
    }

    mount();
    return { viewport, render, offsetOf, elementById: (id) => elements.get(id) || null };
}

/** Runs `callback` with `document.getElementById` bound to a harness. */
function withDocumentFor(harness, callback) {
    const hadDocument = "document" in globalThis;
    const original = globalThis.document;
    globalThis.document = { getElementById: harness.elementById };
    try {
        return callback();
    } finally {
        if (hadDocument) globalThis.document = original;
        else delete globalThis.document;
    }
}

describe("shared/virtual-list paging", () => {
    test("anchors on the first row that is at least partly visible", () => {
        const list = createScrollHarness(["a", "b", "c", "d"]);
        list.viewport.scrollTop = 70; // "a" is fully above, "b" straddles the top
        const anchor = getScrollAnchor(list.viewport);
        assert.equal(anchor.id, "b");
        assert.equal(Math.round(anchor.offset), -10);
        assert.equal(anchor.scrollTop, 70);
        assert.equal(anchor.scrollHeight, 240);
        assert.equal(anchor.clientHeight, 320);
    });

    test("puts the anchor row back after the DOM is rebuilt", () => {
        const list = createScrollHarness(["a", "b", "c", "d"]);
        list.viewport.scrollTop = 40;
        const before = list.offsetOf("b");
        const anchor = getScrollAnchor(list.viewport);

        withDocumentFor(list, () => {
            list.render();
            // A row above grows by 60px, pushing everything below it down.
            list.viewport.scrollTop += 60;
            assert.equal(restoreScrollAnchor(list.viewport, anchor), true);
        });

        assert.equal(Math.round(list.offsetOf("b")), Math.round(before));
    });

    test("does not nudge the viewport when the anchor already sits in place", () => {
        const list = createScrollHarness(["a", "b", "c", "d"]);
        list.viewport.scrollTop = 90;
        const anchor = getScrollAnchor(list.viewport);
        restoreScrollAnchor(list.viewport, anchor);
        assert.equal(list.viewport.scrollTop, 90);
    });

    test("falls back to the distance the content grew, never to the top", () => {
        const list = createScrollHarness(["a", "b", "c"]);
        list.viewport.scrollTop = 0;
        const anchor = getScrollAnchor(list.viewport);
        list.render(["x", "y", "z"]); // 180px inserted above
        assert.equal(fallbackScrollTop(anchor, "back", list.viewport), 180);
    });

    test("falls back to the distance from the bottom when paging forward", () => {
        const viewport = { scrollHeight: 900, scrollTop: 500, clientHeight: 300 };
        const anchor = { scrollTop: 500, scrollHeight: 700, clientHeight: 300, offset: 0, id: "a" };
        // 200px were appended below; the reader keeps the same 100px from the edge.
        assert.equal(fallbackScrollTop(anchor, "forward", viewport), 700);
    });

    test("paging back keeps the reader on the same row", () => {
        const list = createScrollHarness(["m1", "m2", "m3", "m4", "m5", "m6"]);
        const state = { filteredMessages: new Array(20), renderRange: { start: 6, end: 12 } };
        list.viewport.scrollTop = 0;
        const before = list.offsetOf("m1");

        withDocumentFor(list, () => {
            paginateOnScroll(list.viewport, state, {
                batchSize: 6,
                maxRendered: 12,
                render: () => list.render(["n1", "n2", "n3", "n4", "n5", "n6"])
            });
        });

        assert.deepEqual(state.renderRange, { start: 0, end: 12 });
        assert.equal(Math.round(list.offsetOf("m1")), Math.round(before));
    });

    test("paging forward keeps the reader on the same row", () => {
        const list = createScrollHarness(["m1", "m2", "m3", "m4", "m5", "m6"]);
        const state = { filteredMessages: new Array(20), renderRange: { start: 6, end: 12 } };
        list.viewport.scrollTop = list.viewport.scrollHeight - list.viewport.clientHeight;
        const before = list.offsetOf("m4");

        withDocumentFor(list, () => {
            paginateOnScroll(list.viewport, state, {
                batchSize: 6,
                maxRendered: 12,
                render: () => list.render([], ["n1", "n2", "n3", "n4", "n5", "n6"])
            });
        });

        assert.deepEqual(state.renderRange, { start: 6, end: 18 });
        assert.equal(Math.round(list.offsetOf("m4")), Math.round(before));
    });

    test("restoring the same anchor twice never double-corrects", () => {
        const list = createScrollHarness(["a", "b", "c", "d"]);
        list.viewport.scrollTop = 45;
        const anchor = getScrollAnchor(list.viewport);
        const before = list.offsetOf("b");

        withDocumentFor(list, () => {
            list.render();
            list.viewport.scrollTop += 60;
            assert.equal(restoreScrollAnchor(list.viewport, anchor), true);
            // A second caller (another photo finishing) must see nothing to do.
            assert.equal(restoreScrollAnchor(list.viewport, anchor), true);
        });

        assert.equal(Math.round(list.offsetOf("b")), Math.round(before));
    });

    test("a lost anchor corrects by the content delta instead of teleporting", () => {
        const list = createScrollHarness(["m1", "m2", "m3", "m4", "m5", "m6"]);
        const state = { filteredMessages: new Array(20), renderRange: { start: 6, end: 12 } };
        list.viewport.scrollTop = 0;

        withDocumentFor(list, () => {
            paginateOnScroll(list.viewport, state, {
                batchSize: 6,
                maxRendered: 12,
                // None of the previously rendered rows survive this render.
                render: () => list.render(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11", "n12"], [], { replace: true })
            });
        });

        // 360px of new rows now sit above the old window: the reader is moved
        // down by exactly that instead of being thrown to the top or bottom.
        assert.equal(list.viewport.scrollTop, 360);
    });

    test("does nothing at the edges of the whole conversation", () => {
        const list = createScrollHarness(["m1", "m2"]);
        const state = { filteredMessages: [{}, {}], renderRange: { start: 0, end: 2 } };
        list.viewport.scrollTop = 0;
        const rendered = [];
        const changed = paginateOnScroll(list.viewport, state, {
            batchSize: 6,
            maxRendered: 12,
            render: () => rendered.push(1)
        });
        assert.equal(changed, false);
        assert.equal(rendered.length, 0);
        assert.equal(list.viewport.scrollTop, 0);
    });
});

describe("shared/lazy-media", () => {
    const box = (top, height) => ({ top, height });

    test("a photo growing above the reader shifts the viewport by its growth", () => {
        // Box sat from -120 to 60 in viewport coordinates; the reader is at 0.
        const previous = box(-120, 180);
        const current = box(-120, 380);
        assert.equal(compensatingScrollShift(previous, current, 0), 200);
    });

    test("a photo below the reading line does not move the reader", () => {
        const previous = box(40, 180);
        const current = box(40, 380);
        assert.equal(compensatingScrollShift(previous, current, 0), 0);
    });

    test("a photo shrinking above the reader shifts back", () => {
        const previous = box(-200, 400);
        const current = box(-200, 120);
        assert.equal(compensatingScrollShift(previous, current, 0), -280);
    });

    test("an unchanged box is a no-op", () => {
        assert.equal(compensatingScrollShift(box(-50, 200), box(-50, 200), 0), 0);
    });

    test("a decoded photo reserves its real ratio on the next render", () => {
        assert.equal(mediaRatioStyle({ ratio: 1.5 }), ' style="aspect-ratio: 1.5"');
    });

    test("a decoded photo reports the ratio its intrinsic size implies", () => {
        assert.equal(mediaRatioFrom({ naturalWidth: 800, naturalHeight: 600 }), 800 / 600);
    });

    test("a decoded video reports its ratio from videoWidth/videoHeight", () => {
        // A vertical clip: only videos expose these fields, which is why the
        // photo-only version kept the generic 16/9 placeholder.
        assert.equal(mediaRatioFrom({ videoWidth: 720, videoHeight: 1280 }), 0.5625);
        assert.equal(mediaRatioFrom({ naturalWidth: 0, naturalHeight: 0, videoWidth: 1920, videoHeight: 1080 }), 1920 / 1080);
    });

    test("an undecoded attachment reports no ratio", () => {
        assert.equal(mediaRatioFrom({}), 0);
        assert.equal(mediaRatioFrom({ naturalWidth: 0, naturalHeight: 0 }), 0);
        assert.equal(mediaRatioFrom({ naturalWidth: 800 }), 0);
        assert.equal(mediaRatioFrom(undefined), 0);
    });

    test("an unknown ratio reserves nothing", () => {
        assert.equal(mediaRatioStyle(undefined), "");
        assert.equal(mediaRatioStyle({}), "");
        assert.equal(mediaRatioStyle({ ratio: 0 }), "");
        assert.equal(mediaRatioStyle({ ratio: Number.NaN }), "");
    });
});
