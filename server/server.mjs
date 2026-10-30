import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import express from "express";
import { FileStore } from "@tus/file-store";
import { Server as TusServer } from "@tus/server";
import { BlobReader, ZipReader } from "@zip.js/zip.js";

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
    const archiveManifestCache = new Map();

    async function getArchiveManifest(id) {
        if (archiveManifestCache.has(id)) return archiveManifestCache.get(id);
        const record = catalog[id];
        if (!record) return null;
        if (!/\.zip$/i.test(record.fileName)) {
            const manifest = { archiveType: "txt", chatFileName: record.fileName, chatSize: record.size, attachments: [] };
            archiveManifestCache.set(id, manifest);
            return manifest;
        }

        const blob = await openAsBlob(path.join(uploadDir, id));
        const zip = new ZipReader(new BlobReader(blob));
        try {
            const entries = (await zip.getEntries()).filter((entry) => !entry.directory && !entry.filename.startsWith("__MACOSX/"));
            const chatEntry = entries
                .filter((entry) => entry.filename.toLowerCase().endsWith(".txt"))
                .sort((a, b) => (b.uncompressedSize || 0) - (a.uncompressedSize || 0))[0];
            if (!chatEntry) throw new Error("No .txt chat file found in ZIP archive.");
            const manifest = {
                archiveType: "zip",
                chatFileName: chatEntry.filename,
                chatSize: chatEntry.uncompressedSize || 0,
                attachments: entries.filter((entry) => entry !== chatEntry).map((entry) => ({
                    name: path.posix.basename(entry.filename),
                    path: entry.filename,
                    size: entry.uncompressedSize || 0
                }))
            };
            archiveManifestCache.set(id, manifest);
            return manifest;
        } finally {
            await zip.close();
        }
    }

    async function streamZipEntry(id, entryPath, response, contentType) {
        const blob = await openAsBlob(path.join(uploadDir, id));
        const zip = new ZipReader(new BlobReader(blob));
        try {
            const entry = (await zip.getEntries()).find((item) => !item.directory && item.filename === entryPath);
            if (!entry) return false;
            response.set({
                "Content-Type": contentType,
                "Content-Length": String(entry.uncompressedSize || 0),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline"
            });
            await entry.getData(Writable.toWeb(response));
            return true;
        } finally {
            await zip.close();
        }
    }

    async function streamRangedZipEntry(id, entryPath, rangeHeader, response, contentType) {
        const blob = await openAsBlob(path.join(uploadDir, id));
        const zip = new ZipReader(new BlobReader(blob));
        const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "whatsview-range-"));
        const temporaryFile = path.join(temporaryDir, "media.bin");
        try {
            const entry = (await zip.getEntries()).find((item) => !item.directory && item.filename === entryPath);
            if (!entry) {
                await rm(temporaryDir, { recursive: true, force: true });
                return response.sendStatus(404);
            }
            await entry.getData(Writable.toWeb(createWriteStream(temporaryFile)));
        } catch (error) {
            await rm(temporaryDir, { recursive: true, force: true });
            throw error;
        } finally {
            await zip.close();
        }

        const { size } = await stat(temporaryFile);
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        let start = match && match[1] ? Number(match[1]) : null;
        let end = match && match[2] ? Number(match[2]) : null;
        if (start == null && end != null) {
            start = Math.max(0, size - end);
            end = size - 1;
        } else {
            start ??= 0;
            end ??= size - 1;
        }
        if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
            await rm(temporaryDir, { recursive: true, force: true });
            return response.status(416).set("Content-Range", `bytes */${size}`).end();
        }
        end = Math.min(end, size - 1);
        response.status(206).set({
            "Content-Type": contentType,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline"
        });
        const cleanup = () => rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
        response.once("close", cleanup);
        createReadStream(temporaryFile, { start, end }).on("error", (error) => {
            cleanup();
            if (!response.headersSent) response.status(500).end();
            else response.destroy(error);
        }).pipe(response);
    }
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
        const entries = Object.values(catalog)
            .map(({ favorites: _favorites, ...record }) => record)
            .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
        response.set("Cache-Control", "no-store").json(entries);
    });

    app.get("/api/chats/:id/manifest", async (request, response, next) => {
        const { id } = request.params;
        if (!validId(id) || !catalog[id]) return response.sendStatus(404);
        try {
            const manifest = await getArchiveManifest(id);
            response.set("Cache-Control", "no-store").json({
                ...manifest,
                id,
                originalFileName: catalog[id].fileName
            });
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/chats/:id/chat", async (request, response, next) => {
        const { id } = request.params;
        const record = catalog[id];
        if (!validId(id) || !record) return response.sendStatus(404);
        try {
            const manifest = await getArchiveManifest(id);
            if (manifest.archiveType === "txt") {
                const filePath = path.join(uploadDir, id);
                const fileStat = await stat(filePath);
                response.set({
                    "Content-Type": "text/plain; charset=utf-8",
                    "Content-Length": String(fileStat.size),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Disposition": "inline"
                });
                createReadStream(filePath).on("error", next).pipe(response);
                return;
            }
            const found = await streamZipEntry(id, manifest.chatFileName, response, "text/plain; charset=utf-8");
            if (!found) response.sendStatus(404);
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/chats/:id/media", async (request, response, next) => {
        const { id } = request.params;
        const record = catalog[id];
        const requestedPath = request.query.path;
        if (!validId(id) || !record || typeof requestedPath !== "string") return response.sendStatus(404);
        try {
            const manifest = await getArchiveManifest(id);
            const attachment = manifest.attachments.find((item) => item.path === requestedPath);
            if (!attachment || manifest.archiveType !== "zip") return response.sendStatus(404);
            const extension = path.posix.extname(attachment.name).slice(1).toLowerCase();
            const contentType = ({
                jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
                heic: "image/heic", heif: "image/heif", mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
                m4v: "video/x-m4v", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg",
                ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", aac: "audio/aac", pdf: "application/pdf",
                txt: "text/plain; charset=utf-8", vcf: "text/vcard"
            })[extension] || "application/octet-stream";
            if (request.headers.range) {
                await streamRangedZipEntry(id, requestedPath, request.headers.range, response, contentType);
                return;
            }
            const found = await streamZipEntry(id, requestedPath, response, contentType);
            if (!found) response.sendStatus(404);
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/chats/:id/state", (request, response) => {
        const { id } = request.params;
        const record = catalog[id];
        if (!validId(id) || !record) return response.sendStatus(404);
        response.set("Cache-Control", "no-store").json({ favorites: record.favorites || [] });
    });

    app.put("/api/chats/:id/state", express.json({ limit: "5mb" }), async (request, response, next) => {
        const { id } = request.params;
        const record = catalog[id];
        if (!validId(id) || !record) return response.sendStatus(404);
        const favorites = request.body?.favorites;
        if (!Array.isArray(favorites) || favorites.length > 50_000 || favorites.some((value) => typeof value !== "string" || value.length > 256)) {
            return response.status(400).json({ error: "Invalid favorites list." });
        }
        try {
            const uniqueFavorites = [...new Set(favorites)];
            await updateCatalog((next) => { next[id] = { ...next[id], favorites: uniqueFavorites }; });
            response.set("Cache-Control", "no-store").json({ favorites: uniqueFavorites });
        } catch (error) {
            next(error);
        }
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
            archiveManifestCache.delete(id);
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
