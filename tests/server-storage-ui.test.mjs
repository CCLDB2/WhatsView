import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("server storage transfer feedback and automatic sync", () => {
    test("saved chat panel has an accessible loading indicator and percentage bar", () => {
        const html = read("public/viewer.html");
        assert.equal((html.match(/data-server-transfer-progress/g) || []).length, 2);
        assert.equal((html.match(/data-server-transfer-percent/g) || []).length, 2);
        assert.match(html, /role="status" aria-live="polite"/);
    });

    test("opening a saved chat streams bytes and updates progress while list refreshes automatically", () => {
        const module = read("js/whatsapp/server-storage.js");
        const session = read("js/whatsapp/session.js");
        assert.match(module, /\/manifest`/);
        assert.doesNotMatch(module, /\/download`/);
        assert.match(session, /reader\.read\(\)/);
        assert.match(session, /onRemoteProgress\?\.\(loaded, total\)/);
        assert.match(module, /received \/ total \* 100/);
        assert.match(module, /setInterval\(\(\) =>/);
        assert.match(module, /visibilitychange/);
        assert.match(module, /15_000/);
        assert.match(module, /actualizado/);
    });
});
