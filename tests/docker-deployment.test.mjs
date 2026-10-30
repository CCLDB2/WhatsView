import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Docker deployment files", () => {
    test("Dockerfile exposes the app's internal HTTP port", () => {
        assert.match(read("Dockerfile"), /^EXPOSE 80\s*$/m);
    });

    test("persistent data volume is mounted at the app data directory", () => {
        const compose = read("docker-compose.yml");
        assert.match(compose, /whatsview_data:\/data/);
        assert.match(compose, /whatsview_data:/);
        assert.match(read("server/server.mjs"), /\/healthz/);
    });

    test("Docker build context excludes exported chat files", () => {
        const ignore = read(".dockerignore");
        assert.match(ignore, /^\*\.zip$/m);
        assert.match(ignore, /^\*\.txt$/m);
    });
});
