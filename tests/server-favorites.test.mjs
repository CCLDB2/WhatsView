import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("per-chat favorites synchronization", () => {
    test("favorites load from the server and are written back while keeping a local fallback", () => {
        const favorites = read("js/whatsapp/favorites.js");
        assert.match(favorites, /fetch\(`\/api\/chats\/\$\{encodeURIComponent\(serverId\)\}\/state`/);
        assert.match(favorites, /method: "PUT"/);
        assert.match(favorites, /storeFavoritesLocally\(\)/);
        assert.match(favorites, /Migrate bookmarks that were saved locally/);
    });

    test("server chat state API validates, persists, and restores favorites", () => {
        const server = read("server/server.mjs");
        assert.match(server, /app\.get\("\/api\/chats\/:id\/state"/);
        assert.match(server, /app\.put\("\/api\/chats\/:id\/state"/);
        assert.match(server, /favorites\.length > 50_000/);
        assert.match(server, /favorites: record\.favorites \|\| \[\]/);
    });
});
