import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { createWhatsViewApp } from "../server/server.mjs";

const temporaryRoots = [];
const runningServers = [];

async function startApp(dataDir) {
    const { app } = await createWhatsViewApp({ dataDir, maxUploadBytes: 2 * 1024 * 1024 });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    runningServers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
}

function closeServer(server) {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

after(async () => {
    await Promise.all(runningServers.map(closeServer));
    await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("server-side persistent chat storage", () => {
    test("resumable TUS chunks persist on disk and support listing, reopening, and deletion", async () => {
        const dataDir = await mkdtemp(path.join(os.tmpdir(), "whatsview-storage-"));
        temporaryRoots.push(dataDir);
        const base = await startApp(dataDir);
        const contents = Buffer.from("fixture archive bytes", "utf8");
        const metadata = [
            `filename ${Buffer.from("prueba-chat.zip").toString("base64")}`,
            `displayName ${Buffer.from("Ana").toString("base64")}`
        ].join(",");

        const created = await fetch(`${base}/api/uploads`, {
            method: "POST",
            headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(contents.length), "Upload-Metadata": metadata }
        });
        assert.equal(created.status, 201);
        const uploadUrl = new URL(created.headers.get("location"), base);

        const uploaded = await fetch(uploadUrl, {
            method: "PATCH",
            headers: {
                "Tus-Resumable": "1.0.0",
                "Upload-Offset": "0",
                "Content-Type": "application/offset+octet-stream"
            },
            body: contents
        });
        assert.equal(uploaded.status, 204);
        assert.equal(uploaded.headers.get("upload-offset"), String(contents.length));

        const listed = await fetch(`${base}/api/chats`);
        assert.equal(listed.status, 200);
        const [record] = await listed.json();
        assert.equal(record.fileName, "prueba-chat.zip");
        assert.equal(record.displayName, "Ana");
        assert.equal(record.size, contents.length);

        const downloaded = await fetch(`${base}/api/chats/${record.id}/download`);
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), contents);

        const server = runningServers.at(-1);
        await closeServer(server);
        runningServers.splice(runningServers.indexOf(server), 1);
        const restartedBase = await startApp(dataDir);
        const afterRestart = await fetch(`${restartedBase}/api/chats`);
        assert.equal((await afterRestart.json()).length, 1);

        const deleted = await fetch(`${restartedBase}/api/chats/${record.id}`, { method: "DELETE" });
        assert.equal(deleted.status, 204);
        assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "chats.json"), "utf8")), {});
    });
});
