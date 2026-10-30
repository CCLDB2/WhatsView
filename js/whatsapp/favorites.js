/** Per-chat message bookmarks; browser-local with optional server synchronization. */
import { $, escapeHtml } from "../shared/dom.js?v=1.8.23";
import { state } from "./state.js?v=1.8.23";
import { jumpToMessage } from "./search.js?v=1.8.23";

const PREFIX = "chatlume-favorites:";
let remoteSaveTimer = 0;

export async function loadFavorites({ importId = "", fileLabel = "", serverChatId = "" } = {}) {
    if (remoteSaveTimer) clearTimeout(remoteSaveTimer);
    remoteSaveTimer = 0;
    const first = state.messages.find((item) => item.type === "msg")?.id || "";
    const last = [...state.messages].reverse().find((item) => item.type === "msg")?.id || "";
    // Use the same content-derived key on first import and later reopen. The
    // storage record ID is only assigned after the first parse completes.
    const identity = `${fileLabel.toLocaleLowerCase()}|${first}|${last}`;
    state.favoriteStoreKey = identity ? `${PREFIX}${encodeURIComponent(identity)}` : "";
    try {
        const saved = JSON.parse(localStorage.getItem(state.favoriteStoreKey) || "[]");
        state.favoriteIds = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
    } catch {
        state.favoriteIds = new Set();
    }
    state.favoriteServerId = /^[a-f0-9]{32}$/.test(serverChatId) ? serverChatId : "";
    if (state.favoriteServerId) {
        const serverId = state.favoriteServerId;
        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(serverId)}/state`, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const remote = await response.json();
            if (state.favoriteServerId !== serverId) return;
            if (Array.isArray(remote.favorites) && remote.favorites.length) {
                state.favoriteIds = new Set(remote.favorites.filter((id) => typeof id === "string"));
                storeFavoritesLocally();
            } else if (state.favoriteIds.size) {
                // Migrate bookmarks that were saved locally before server sync existed.
                await saveFavoritesToServer();
            }
        } catch (error) {
            console.warn("Server favorites could not be loaded; using this browser's copy:", error);
        }
    }
    updateFavoriteControls();
}

export function toggleFavorite(messageId) {
    const message = state.messages.find((item) => item.id === messageId && item.type === "msg");
    if (!message) return;
    if (state.favoriteIds.has(messageId)) state.favoriteIds.delete(messageId);
    else state.favoriteIds.add(messageId);
    storeFavoritesLocally();
    scheduleServerSave();
    updateFavoriteControls();
}

function storeFavoritesLocally() {
    try {
        if (state.favoriteStoreKey) localStorage.setItem(state.favoriteStoreKey, JSON.stringify([...state.favoriteIds]));
    } catch (error) {
        console.warn("Message favorite could not be saved locally:", error);
    }
}

function scheduleServerSave() {
    if (!state.favoriteServerId) return;
    if (remoteSaveTimer) clearTimeout(remoteSaveTimer);
    remoteSaveTimer = window.setTimeout(() => {
        remoteSaveTimer = 0;
        saveFavoritesToServer();
    }, 250);
}

async function saveFavoritesToServer() {
    const serverId = state.favoriteServerId;
    if (!serverId) return;
    const favorites = [...state.favoriteIds];
    try {
        const response = await fetch(`/api/chats/${encodeURIComponent(serverId)}/state`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ favorites })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        console.warn("Message favorites are saved in this browser but server sync failed:", error);
    }
}

export function toggleFavoritesPanel() {
    const panel = $("favorites-panel");
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    $("favorites-toggle")?.setAttribute("aria-expanded", String(open));
    if (open) renderFavoritesPanel();
}

export function renderFavoritesPanel() {
    const panel = $("favorites-list");
    const count = $("favorites-count");
    if (!panel) return;
    const favorites = state.messages.filter((item) => item.type === "msg" && state.favoriteIds.has(item.id));
    if (count) count.textContent = String(favorites.length);
    panel.innerHTML = favorites.length ? favorites.map((item) => {
        const text = item.text || item.mediaItems?.[0]?.name || "Media message";
        const snippet = text.length > 120 ? `${text.slice(0, 117)}…` : text;
        return `<button class="favorite-entry" type="button" data-favorite-message="${escapeHtml(item.id)}"><span class="favorite-entry-meta">${escapeHtml(item.sender)} · ${escapeHtml(item.rawDate || item.date || "")} ${escapeHtml(item.rawTime || item.time || "")}</span><span class="favorite-entry-text">${escapeHtml(snippet)}</span></button>`;
    }).join("") : '<p class="favorites-empty">Todavía no marcaste mensajes como favoritos.</p>';
}

export function handleFavoriteListClick(event) {
    const button = event.target.closest("[data-favorite-message]");
    if (!button) return;
    jumpToMessage(button.dataset.favoriteMessage);
    $("favorites-panel").hidden = true;
    $("favorites-toggle")?.setAttribute("aria-expanded", "false");
}

export function updateFavoriteControls() {
    document.querySelectorAll("[data-favorite-toggle]").forEach((button) => {
        const active = state.favoriteIds.has(button.dataset.favoriteToggle);
        button.classList.toggle("is-favorite", active);
        const icon = button.querySelector("i");
        icon?.classList.toggle("ph-fill", active);
        icon?.classList.toggle("ph", !active);
        button.setAttribute("aria-pressed", String(active));
        button.setAttribute("aria-label", active ? "Quitar de favoritos" : "Marcar como favorito");
        button.title = active ? "Quitar de favoritos" : "Marcar como favorito";
    });
    const count = $("favorites-count");
    if (count) count.textContent = String(state.favoriteIds.size);
}
