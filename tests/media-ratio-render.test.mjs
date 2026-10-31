/**
 * Both viewers must reserve a decoded video's real box.
 *
 * A photo tells the browser its size through `naturalWidth`/`naturalHeight`;
 * a video only through `videoWidth`/`videoHeight`. When the ratio was read
 * from the photo pair alone, every video kept the generic 16/9 placeholder and
 * snapped to its real height on the render after it had been decoded — which
 * moved the conversation under the reader.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { versioned } from "./versioned.mjs";

const { state } = await versioned("../js/whatsapp/state.js");
const { renderChatList: renderWhatsApp } = await versioned("../js/whatsapp/render.js");
const { igState } = await versioned("../js/instagram/state.js");
const { renderChatList: renderInstagram } = await versioned("../js/instagram/render.js");

/**
 * Runs `render` with the ids it needs bound to a bare list node.
 *
 * The viewers read their list, viewport and buttons through `document`; a
 * render only writes `innerHTML` and hands the nodes to the lazy loader, so
 * the stub only has to answer those lookups.
 */
function renderedHtml(listId, render) {
    const html = { value: "" };
    const list = {
        set innerHTML(value) { html.value = value; },
        get innerHTML() { return html.value; },
        querySelectorAll: () => []
    };

    const hadDocument = "document" in globalThis;
    const hadWindow = "window" in globalThis;
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = {
        getElementById: (id) => (id === listId ? list : null),
        querySelector: () => null,
        querySelectorAll: () => []
    };
    globalThis.window = { setTimeout: () => 0, addEventListener() {} };
    try {
        render();
    } finally {
        if (hadDocument) globalThis.document = originalDocument;
        else delete globalThis.document;
        if (hadWindow) globalThis.window = originalWindow;
        else delete globalThis.window;
    }
    return html.value;
}

describe("video attachments keep their box", () => {
    beforeEach(() => {
        state.mediaStore = new Map();
        state.filteredMessages = [];
        state.renderRange = { start: 0, end: 0 };
        igState.mediaStore = new Map();
        igState.filteredMessages = [];
        igState.renderRange = { start: 0, end: 0 };
    });

    test("the WhatsApp viewer emits the ratio on the video element", () => {
        state.mediaStore.set("vid1", { id: "vid1", ratio: 0.5625 });
        state.filteredMessages = [{
            id: "m1",
            type: "msg",
            rawTime: "10:00",
            sender: "Ana",
            isMe: false,
            text: "",
            mediaItems: [{ id: "vid1", kind: "video", status: "available", name: "clip.mp4" }]
        }];
        state.renderRange = { start: 0, end: 1 };

        const html = renderedHtml("message-list", renderWhatsApp);
        assert.match(html, /<video[^>]*style="aspect-ratio: 0.5625"/);
    });

    test("the Instagram viewer emits the ratio on the video element", () => {
        igState.mediaStore.set("vid1", { id: "vid1", ratio: 0.5625 });
        igState.filteredMessages = [{
            id: "m1",
            type: "msg",
            ts: 1_700_000_000_000,
            sender: "Ana",
            isMe: false,
            text: "",
            reactions: [],
            mediaItems: [{ id: "vid1", kind: "video", status: "available", name: "clip.mp4" }]
        }];
        igState.renderRange = { start: 0, end: 1 };

        const html = renderedHtml("ig-message-list", renderInstagram);
        assert.match(html, /<video[^>]*style="aspect-ratio: 0.5625"/);
    });

    test("a video that has not been decoded yet reserves nothing", () => {
        state.filteredMessages = [{
            id: "m1",
            type: "msg",
            rawTime: "10:00",
            sender: "Ana",
            isMe: false,
            text: "",
            mediaItems: [{ id: "vid1", kind: "video", status: "available", name: "clip.mp4" }]
        }];
        state.renderRange = { start: 0, end: 1 };

        assert.doesNotMatch(renderedHtml("message-list", renderWhatsApp), /aspect-ratio/);
    });
});
