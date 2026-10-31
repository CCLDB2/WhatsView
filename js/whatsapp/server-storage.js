/** Optional self-hosted archive storage with resumable, proxy-safe uploads. */
import { $, escapeAttribute, escapeHtml } from "../shared/dom.js?v=1.8.25";
import { formatBytes } from "../shared/media-types.js?v=1.8.25";
import { getLocale, t } from "../i18n.js?v=1.8.25";

const LAST_CLOUD_CHAT_KEY = "chatlume-last-server-chat";
const LAST_POSITION_KEY = "chatlume-last-position";
const CHUNK_SIZE = 8 * 1024 * 1024;
const state = { enabled: false, records: [], hooks: {}, storage: null, refreshPromise: null, refreshTimer: 0 };

export function isServerStorageEnabled() {
    return state.enabled;
}

export function rememberServerChat(id) {
    try {
        localStorage.setItem(LAST_CLOUD_CHAT_KEY, id);
    } catch {
        // The server copy still exists if browser storage is disabled.
    }
}

function savedPosition(id) {
    try {
        const saved = JSON.parse(localStorage.getItem(LAST_POSITION_KEY) || "null");
        return saved?.id === `server:${id}` ? saved.position : null;
    } catch {
        return null;
    }
}

export async function initServerStorage({ openChat, closeChat }) {
    state.hooks = { openChat, closeChat };
    const sections = [...document.querySelectorAll("[data-server-storage]")];
    try {
        const response = await fetch("/api/storage", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.storage = await response.json();
        state.enabled = Boolean(state.storage.enabled);
        sections.forEach((section) => { section.hidden = !state.enabled; });
        if (!state.enabled) return;
        await refreshServerChats();
        startAutoRefresh();

        let lastId = "";
        try { lastId = localStorage.getItem(LAST_CLOUD_CHAT_KEY) || ""; } catch { /* optional */ }
        const last = state.records.find((record) => record.id === lastId);
        if (last) await openServerChat(last);
    } catch {
        // Local static development stays browser-only when no server API exists.
        state.enabled = false;
        sections.forEach((section) => { section.hidden = true; });
    }
}

export async function refreshServerChats() {
    if (!state.enabled) return;
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = refreshServerChatsFromApi();
    try {
        await state.refreshPromise;
    } finally {
        state.refreshPromise = null;
    }
}

async function refreshServerChatsFromApi() {
    try {
        const response = await fetch("/api/chats", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.records = await response.json();
        const storageResponse = await fetch("/api/storage", { cache: "no-store" });
        if (storageResponse.ok) state.storage = await storageResponse.json();
        renderServerChats();
    } catch (error) {
        setServerStatus(t("No se pudo consultar el disco del servidor: {error}", { error: error.message }), "error");
    }
}

function startAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") refreshServerChats();
    }, 15_000);
    window.addEventListener("focus", refreshServerChats);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshServerChats();
    });
}

function renderServerChats() {
    const listHtml = state.records.length ? state.records.map((record) => {
        const title = record.fileName || t("Chat");
        const meta = [record.displayName, formatBytes(record.size), record.uploadedAt ? new Date(record.uploadedAt).toLocaleDateString(getLocale()) : ""]
            .filter(Boolean).join(" · ");
        return `<div class="server-chat-item"><button type="button" class="server-chat-open" data-server-open="${escapeAttribute(record.id)}"><span class="server-chat-title">${escapeHtml(title)}</span><span class="server-chat-meta">${escapeHtml(meta)}</span></button><button type="button" class="server-chat-delete" data-server-delete="${escapeAttribute(record.id)}" aria-label="${escapeAttribute(t("Eliminar {name} del servidor", { name: title }))}" title="${escapeAttribute(t("Eliminar del servidor"))}"><i class="ph ph-trash" aria-hidden="true"></i></button></div>`;
    }).join("") : `<p class="server-storage-empty">${escapeHtml(t("No hay chats guardados en el servidor."))}</p>`;

    document.querySelectorAll("[data-server-chat-list]").forEach((element) => { element.innerHTML = listHtml; });
    document.querySelectorAll("[data-server-usage]").forEach((element) => {
        const used = formatBytes(state.storage?.usedBytes || 0);
        const free = state.storage?.freeBytes == null ? "" : t(" · {size} libres", { size: formatBytes(state.storage.freeBytes) });
        const syncTime = new Date().toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        element.textContent = state.records.length === 1
            ? t("{count} archivo · {used} usados{free} · actualizado {time}", { count: state.records.length, used, free, time: syncTime })
            : t("{count} archivos · {used} usados{free} · actualizado {time}", { count: state.records.length, used, free, time: syncTime });
    });
}

function setServerStatus(message, tone = "") {
    document.querySelectorAll("[data-server-status]").forEach((element) => {
        element.textContent = message;
        element.dataset.tone = tone;
    });
}

export function uploadChatToServer(file, displayName, onProgress = () => {}) {
    if (!state.enabled || !window.tus?.Upload) {
        return Promise.reject(new Error(t("El almacenamiento del servidor no está disponible.")));
    }

    return new Promise((resolve, reject) => {
        const upload = new window.tus.Upload(file, {
            endpoint: "/api/uploads",
            chunkSize: CHUNK_SIZE,
            retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
            metadata: { filename: file.name, displayName },
            removeFingerprintOnSuccess: true,
            onProgress(bytesUploaded, bytesTotal) {
                const percentage = bytesTotal ? Math.floor(bytesUploaded / bytesTotal * 100) : 0;
                setServerStatus(t("Subiendo al disco privado de Dockploy… {percent}% ({uploaded} / {total})", {
                    percent: percentage,
                    uploaded: formatBytes(bytesUploaded),
                    total: formatBytes(bytesTotal)
                }));
                onProgress(percentage, bytesUploaded, bytesTotal);
            },
            onError(error) {
                setServerStatus(t("Falló la subida (puedes volver a seleccionar el mismo archivo para reanudar): {error}", { error: error.message }), "error");
                reject(error);
            },
            onSuccess() {
                const id = new URL(upload.url, window.location.href).pathname.split("/").filter(Boolean).at(-1);
                if (!/^[a-f0-9]{32}$/.test(id || "")) {
                    reject(new Error(t("El servidor completó la carga pero no devolvió un identificador válido.")));
                    return;
                }
                refreshServerChats().then(() => {
                    setServerStatus(t("Copia guardada en el disco del servidor Dockploy."));
                    resolve(id);
                }, reject);
            }
        });

        upload.findPreviousUploads().then((previous) => {
            if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
            upload.start();
        }).catch(reject);
    });
}

export async function handleServerStorageClick(event) {
    const refreshButton = event.target.closest("[data-server-refresh]");
    if (refreshButton) {
        await refreshServerChats();
        return;
    }

    const openButton = event.target.closest("[data-server-open]");
    if (openButton) {
        const record = state.records.find((item) => item.id === openButton.dataset.serverOpen);
        if (record) await openServerChat(record);
        return;
    }

    const deleteButton = event.target.closest("[data-server-delete]");
    if (deleteButton) {
        const record = state.records.find((item) => item.id === deleteButton.dataset.serverDelete);
        if (record) await deleteServerChat(record);
    }
}

async function openServerChat(record) {
    if (!state.hooks.openChat) return;
    setServerStatus(t("Preparando {name} desde el servidor…", { name: record.fileName }));
    try {
        setTransferProgress(t("Preparando el archivo en Dockploy"), 0, true);
        const response = await fetch(`/api/chats/${encodeURIComponent(record.id)}/manifest`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json();
        setTransferProgress(t("Leyendo mensajes (sin bajar el ZIP completo)"), 0, true);
        await state.hooks.openChat(null, {
            displayName: record.displayName || "",
            fileLabel: record.fileName,
            remoteImportId: record.id,
            remoteManifest: manifest,
            onRemoteProgress(received, total) {
                const percentage = total ? Math.min(100, Math.floor(received / total * 100)) : null;
                const totalCopy = total ? formatBytes(total) : t("tamaño desconocido");
                setTransferProgress(t("Leyendo mensajes · {received} de {total}", { received: formatBytes(received), total: totalCopy }), percentage, percentage == null);
            },
            scrollPosition: savedPosition(record.id),
            persist: false
        });
        clearTransferProgress();
        setServerStatus(t("Leído desde Dockploy · ZIP original {size}; los medios se cargan al verlos.", { size: formatBytes(record.size) }));
    } catch (error) {
        clearTransferProgress();
        setServerStatus(t("No se pudo abrir el archivo: {error}", { error: error.message }), "error");
    }
}

function setTransferProgress(label, percent, indeterminate) {
    document.querySelectorAll("[data-server-transfer]").forEach((element) => {
        element.hidden = false;
        const labelElement = element.querySelector("[data-server-transfer-label]");
        const percentElement = element.querySelector("[data-server-transfer-percent]");
        const progress = element.querySelector("[data-server-transfer-progress]");
        labelElement.textContent = label;
        if (indeterminate || percent == null) {
            progress.removeAttribute("value");
            percentElement.textContent = "";
        } else {
            progress.value = percent;
            percentElement.textContent = `${percent}%`;
        }
    });
}

function clearTransferProgress() {
    document.querySelectorAll("[data-server-transfer]").forEach((element) => {
        element.hidden = true;
        const progress = element.querySelector("[data-server-transfer-progress]");
        progress.value = 0;
    });
}

async function deleteServerChat(record) {
    if (!window.confirm(t("¿Eliminar “{name}” permanentemente del disco de Dockploy?", { name: record.fileName }))) return;
    try {
        const response = await fetch(`/api/chats/${encodeURIComponent(record.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (getLastCloudChatId() === record.id) state.hooks.closeChat?.();
        if (record.id === getLastCloudChatId()) {
            try { localStorage.removeItem(LAST_CLOUD_CHAT_KEY); } catch { /* optional */ }
        }
        await refreshServerChats();
        setServerStatus(t("Archivo eliminado del disco del servidor."));
    } catch (error) {
        setServerStatus(t("No se pudo eliminar el archivo: {error}", { error: error.message }), "error");
    }
}

function getLastCloudChatId() {
    try { return localStorage.getItem(LAST_CLOUD_CHAT_KEY) || ""; } catch { return ""; }
}
