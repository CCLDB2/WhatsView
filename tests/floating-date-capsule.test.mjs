import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("WhatsApp floating current-date capsule", () => {
    test("date navigation lives only in the header options menu", () => {
        const html = read("public/viewer.html");
        const menuStart = html.indexOf('id="header-menu"');
        const menu = html.slice(menuStart, html.indexOf("</header>", menuStart));
        assert.match(menu, /id="date-jump-action"[^>]*>[^<]*/);
        assert.match(menu, /Ir a una fecha/);
        assert.doesNotMatch(html, /id="date-jump-btn"/);
        assert.doesNotMatch(html, /id="date-filter-container"/);
        assert.doesNotMatch(html, /id="date-filter-action"/);
        assert.match(read("js/script.js"), /\$\("date-jump-action"\)[^\n]*handleDateJumpAction/);
    });

    test("participants and favorites are options inside the ⋮ menu", () => {
        const html = read("public/viewer.html");
        const menuStart = html.indexOf('id="header-menu"');
        const menu = html.slice(menuStart, html.indexOf("</header>", menuStart));
        assert.match(menu, /id="sender-filter-action"/);
        assert.match(menu, /id="favorites-toggle"/);
        assert.doesNotMatch(html, /class="favorites-toggle"/);
        assert.match(read("js/script.js"), /\$\("favorites-toggle"\)\?\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*closeMenu\(\)/);
    });

    test("favorites panel is anchored on the left", () => {
        const css = read("css/style.css");
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
