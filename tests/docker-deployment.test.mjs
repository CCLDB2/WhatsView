import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Docker deployment files", () => {
    test("Dockerfile exposes Nginx's internal HTTP port", () => {
        assert.match(read("Dockerfile"), /^EXPOSE 80\s*$/m);
    });

    test("Nginx listens on port 80 and provides a health endpoint", () => {
        const config = read("docker/nginx.conf");
        assert.match(config, /listen 80;/);
        assert.match(config, /location = \/healthz/);
    });

    test("Docker build context excludes exported chat files", () => {
        const ignore = read(".dockerignore");
        assert.match(ignore, /^\*\.zip$/m);
        assert.match(ignore, /^\*\.txt$/m);
    });
});
