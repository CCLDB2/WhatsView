import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { FileStore } from "@tus/file-store";
import { Server as TusServer } from "@tus/server";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 ** 3;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFileName(value) {
    const name = path.basename(String(value || "chat.zip").replaceAll("\\", "/"))
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 240);
    return name || "chat.zip";
}

function validId(id) {
    return /^[a-f0-9]{32}$/.test(String(id || ""));
}

export async function createWhatsViewApp({ dataDir = process.env.DATA_DIR || "/data", maxUploadBytes } = {}) {
    const resolvedDataDir = path.resolve(dataDir);
    const uploadDir = path.join(resolvedDataDir, "uploads");
    const catalogPath = path.join(resolvedDataDir, "chats.json");
    const maximum = positiveInteger(maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
    await mkdir(uploadDir, { recursive: true });

    let catalog = {};
    try {
        const parsed = JSON.parse(await readFile(catalogPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) catalog = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    let catalogQueue = Promise.resolve();
    function updateCatalog(mutator) {
        catalogQueue = catalogQueue.then(async () => {
            const next = { ...catalog };
            mutator(next);
            const temporaryPath = `${catalogPath}.tmp`;
            await writeFile(temporaryPath, JSON.stringify(next), { mode: 0o600 });
            await rename(temporaryPath, catalogPath);
            catalog = next;
        });
        return catalogQueue;
    }

    const tusServer = new TusServer({
        path: "/api/uploads",
        datastore: new FileStore({ directory: uploadDir }),
        maxSize: maximum,
        relativeLocation: true,
        // Same-origin only. Pangolin is expected to protect every request to this host.
        allowedOrigins: [],
        async onUploadCreate(_request, upload) {
            const fileName = safeFileName(upload.metadata?.filename);
            if (!/\.(zip|txt)$/i.test(fileName)) {
                throw { status_code: 415, body: "Only WhatsApp .zip or .txt exports are accepted." };
            }
            if (upload.size == null || upload.size > maximum) {
                throw { status_code: 413, body: `Maximum upload size is ${maximum} bytes.` };
            }
            return {
                metadata: {
                    ...upload.metadata,
                    filename: fileName,
                    displayName: String(upload.metadata?.displayName || "").trim().slice(0, 120)
                }
            };
        },
        async onUploadFinish(_request, upload) {
            if (!validId(upload.id) || !upload.storage?.path) {
                throw { status_code: 500, body: "Completed upload has invalid storage metadata." };
            }
            const file = await stat(upload.storage.path);
            const record = {
                id: upload.id,
                fileName: safeFileName(upload.metadata?.filename),
                displayName: String(upload.metadata?.displayName || "").slice(0, 120),
                size: file.size,
                uploadedAt: new Date().toISOString()
            };
            await updateCatalog((next) => { next[record.id] = record; });
            return {};
        }
    });

    const app = express();
    app.disable("x-powered-by");
    app.get("/healthz", (_request, response) => response.status(200).type("text/plain").send("ok\n"));

    app.get("/api/storage", async (_request, response) => {
        const entries = Object.values(catalog);
        const disk = await statfs(resolvedDataDir);
        response.set("Cache-Control", "no-store").json({
            enabled: true,
            maxUploadBytes: maximum,
            usedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
            freeBytes: disk.bavail * disk.bsize,
            chatCount: entries.length
        });
    });

    app.get("/api/chats", (_request, response) => {
        const entries = Object.values(catalog).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
        response.set("Cache-Control", "no-store").json(entries);
    });

    app.get("/api/chats/:id/download", async (request, response, next) => {
        const { id } = request.params;
        const record = catalog[id];
        if (!validId(id) || !record) return response.sendStatus(404);
        try {
            const filePath = path.join(uploadDir, id);
            const fileStat = await stat(filePath);
            const asciiName = record.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
            response.set({
                "Content-Type": /\.zip$/i.test(record.fileName) ? "application/zip" : "text/plain; charset=utf-8",
                "Content-Length": String(fileStat.size),
                "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`,
                "Cache-Control": "no-store"
            });
            createReadStream(filePath).on("error", next).pipe(response);
        } catch (error) {
            if (error.code === "ENOENT") return response.sendStatus(404);
            next(error);
        }
    });

    app.delete("/api/chats/:id", async (request, response, next) => {
        const { id } = request.params;
        if (!validId(id) || !catalog[id]) return response.sendStatus(404);
        try {
            await tusServer.datastore.remove(id);
            await updateCatalog((nextCatalog) => { delete nextCatalog[id]; });
            response.sendStatus(204);
        } catch (error) {
            next(error);
        }
    });

    // Keep TUS requests away from body parsers and static-file middleware.
    app.use((request, response, next) => {
        if (request.path === "/api/uploads" || request.path.startsWith("/api/uploads/")) {
            return tusServer.handle(request, response);
        }
        next();
    });

    app.use(express.static(APP_ROOT, {
        index: "index.html",
        dotfiles: "deny",
        setHeaders(response, filePath) {
            if (/\.(?:html|json|webmanifest)$/i.test(filePath) || path.basename(filePath) === "sw.js") {
                response.setHeader("Cache-Control", "no-cache, must-revalidate");
            }
        }
    }));

    app.use((error, _request, response, _next) => {
        console.error("WhatsView request failed:", error.message);
        if (response.headersSent) return;
        response.status(500).json({ error: "Internal server error" });
    });

    return { app, tusServer };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = positiveInteger(process.env.PORT, 80);
    const { app } = await createWhatsViewApp();
    app.listen(port, "0.0.0.0", () => {
        console.log(`WhatsView listening on port ${port}; persistent chat storage: ${path.resolve(process.env.DATA_DIR || "/data")}`);
    });
}
