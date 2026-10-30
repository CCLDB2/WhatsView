import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("WhatsApp floating current-date capsule", () => {
    test("date navigation is directly visible beside the day filter", () => {
        const html = read("public/viewer.html");
        const container = html.slice(html.indexOf('id="date-filter-container"'), html.indexOf('id="sender-filter-container"'));
        assert.match(container, /id="date-jump-btn"[^>]*aria-label="Go to date"/);
        assert.match(container, /id="date-filter-btn"[^>]*aria-label="Filter messages by day"/);
        assert.match(read("js/script.js"), /\$\("date-jump-btn"\).*handleDateJumpAction/);
    });

    test("favorites capsule and panel are anchored on the left", () => {
        const css = read("css/style.css");
        assert.match(css, /\.favorites-toggle\s*\{[^}]*left:\s*18px;/s);
        assert.match(css, /\.favorites-panel\s*\{[^}]*left:\s*16px;/s);
    });

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
