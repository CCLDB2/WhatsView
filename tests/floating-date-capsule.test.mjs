import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("WhatsApp floating current-date capsule", () => {
    test("viewer has a sticky floating capsule above the scrollable messages", () => {
        const html = read("public/viewer.html");
        const viewport = html.indexOf("id=\"viewport\"");
        const capsule = html.indexOf("id=\"floating-date-capsule\"");
        assert.ok(capsule > viewport);
        assert.match(html.slice(capsule, html.indexOf("<div class=\"empty-placeholder\"", capsule)), /id="floating-date-label"/);
        assert.match(read("css/style.css"), /\.floating-date-capsule\s*\{[^}]*position:\s*sticky;[^}]*top:\s*8px/s);
    });

    test("rendered messages carry their day and scrolling selects the first visible message's date", () => {
        const render = read("js/whatsapp/render.js");
        assert.match(render, /data-day-label="\$\{escapeAttribute\(dayLabel/);
        assert.match(render, /firstVisible\?\.dataset\.dayLabel/);
        assert.match(render, /scheduleFloatingDateSync\(viewport\)/);
    });
});
