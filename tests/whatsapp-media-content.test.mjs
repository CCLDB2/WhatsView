import test from "node:test";
import assert from "node:assert/strict";

import { buildMediaStore } from "../js/whatsapp/media.js";
import { parseMessageContent } from "../js/whatsapp/parser.js";
import { state } from "../js/whatsapp/state.js";

test("Spanish attachment tokens resolve to ZIP media instead of remaining visible text", () => {
    const files = [
        "00011452-STICKER-2026-10-07-00-13-36.webp",
        "00011453-PHOTO-2026-10-07-00-13-40.jpg",
        "00011454-AUDIO-2026-10-07-00-13-45.opus"
    ];
    state.mediaStore.clear();
    state.mediaLookup.clear();
    buildMediaStore(files.map((name) => ({ name, path: `WhatsApp/${name}`, entry: {}, size: 123 })));

    const expectedKinds = ["sticker", "image", "audio"];
    for (const [index, name] of files.entries()) {
        const parsed = parseMessageContent(`<adjunto: ${name}>`);
        assert.equal(parsed.text, "");
        assert.equal(parsed.mediaItems.length, 1);
        assert.equal(parsed.mediaItems[0].status, "available");
        assert.equal(parsed.mediaItems[0].name, name);
        assert.equal(parsed.mediaItems[0].kind, expectedKinds[index]);
    }
});
