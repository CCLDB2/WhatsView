/** Presents Instagram conversation statistics and exports a local image. */
import { $, escapeHtml } from "../shared/dom.js?v=1.8.25";
import { pushOverlayState, popOverlayState } from "../shared/history.js?v=1.8.25";
import { formatDateLabel } from "./format.js?v=1.8.25";
import { igState } from "./state.js?v=1.8.25";
import { showToast } from "./ui.js?v=1.8.25";
import { summarizeInstagramThread } from "./wrapped-model.js?v=1.8.25";
import { t, getLocale } from "../i18n.js?v=1.8.25";

const HTML2CANVAS_URL = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";

export function openInstagramWrapped() {
    if (!igState.messageOnlyCount) { showToast(t("Carga una conversación primero para generar el Wrapped"), "warn"); return; }
    renderInstagramWrapped();
    const modal = $("ig-wrapped-modal");
    if (!modal) return;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("open"));
    pushOverlayState("ig-wrapped");
}

export function closeInstagramWrapped({ fromHistory = false } = {}) {
    const modal = $("ig-wrapped-modal");
    if (!modal || modal.hidden) return;
    modal.classList.remove("open");
    window.setTimeout(() => { if (!modal.classList.contains("open")) modal.hidden = true; }, 120);
    if (!fromHistory) popOverlayState();
}

export function renderInstagramWrapped() {
    const graphic = $("ig-wrapped-graphic");
    if (!graphic) return;
    const summary = summarizeInstagramThread(igState.messages, igState);
    const dateRange = summary.firstTimestamp == null
        ? t("Fecha desconocida")
        : summary.firstTimestamp === summary.lastTimestamp
            ? formatDateLabel(summary.firstTimestamp, igState.settings)
            : `${formatDateLabel(summary.firstTimestamp, igState.settings)} – ${formatDateLabel(summary.lastTimestamp, igState.settings)}`;
    const peak = igState.settings.timeFormat === "24"
        ? `${String(summary.peakHour).padStart(2, "0")}:00`
        : `${(summary.peakHour % 12) || 12} ${summary.peakHour >= 12 ? "PM" : "AM"}`;
    const emojiHtml = summary.topEmojis.length
        ? summary.topEmojis.map(([emoji, count]) => `<div class="wg-emoji-cell"><span class="wg-emoji-char">${escapeHtml(emoji)}</span><span class="wg-emoji-count">${count.toLocaleString(getLocale())}</span></div>`).join("")
        : `<span style='color:#555;font-size:13px'>${escapeHtml(t("No se encontraron emojis"))}</span>`;
    let barHtml = "", labelsHtml = "";
    for (const [name, count] of summary.topSenders) {
        const pct = summary.messageCount ? ((count / summary.messageCount) * 100).toFixed(1) : "0.0";
        barHtml += `<div class="wg-split-segment" style="width:${pct}%;background:#C13584"></div>`;
        labelsHtml += `<div class="wg-split-label"><span class="wg-split-dot">●</span> <span class="wg-name">${escapeHtml(name)}</span> <span class="wg-pct">${pct}%</span></div>`;
    }
    graphic.innerHTML = `<div class="wg-header"><div class="wg-brand-tag">ChatLume Wrapped · Instagram</div><h2>${escapeHtml(igState.chatTitle)}</h2><p>${escapeHtml(dateRange)}</p></div>
        <div class="wg-divider"></div><div class="wg-stats-grid">
        <div class="wg-stat-card"><span>${escapeHtml(t("Mensajes"))}</span><h3>${summary.messageCount.toLocaleString(getLocale())}</h3></div>
        <div class="wg-stat-card"><span>${escapeHtml(t("Palabras"))}</span><h3>${summary.totalWords.toLocaleString(getLocale())}</h3></div>
        <div class="wg-stat-card"><span>${escapeHtml(t("Archivos"))}</span><h3>${summary.mediaCount.toLocaleString(getLocale())}</h3></div>
        <div class="wg-stat-card"><span>${escapeHtml(t("Hora punta"))}</span><h3>${peak}</h3></div></div>
        <div class="wg-section"><div class="wg-label">${escapeHtml(t("Más usados"))}</div><div class="wg-emoji-grid">${emojiHtml}</div></div>
        <div class="wg-section"><div class="wg-label">${escapeHtml(t("Colaboradores principales"))}</div><div class="wg-split"><div class="wg-split-bar">${barHtml}</div><div class="wg-split-labels">${labelsHtml}</div></div></div>
        <div class="wg-brand-footer"><div class="wg-logo"><img src="../assets/logo-64.png" alt=""> ChatLume</div><div class="wg-url">chatlume.app</div></div>`;
}

export async function downloadInstagramWrapped() {
    const graphic = $("ig-wrapped-graphic"), button = $("ig-wrapped-download");
    if (!graphic || !button) return;
    const previous = button.innerHTML;
    button.disabled = true;
    button.textContent = t("Generando...");
    try {
        if (typeof html2canvas === "undefined") await loadHtml2Canvas();
        const canvas = await html2canvas(graphic, { backgroundColor: "#000", scale: 2, useCORS: true, logging: false });
        const link = document.createElement("a");
        link.download = `ChatLume_Instagram_Wrapped_${igState.chatTitle.replace(/[^a-z0-9]/gi, "_")}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        showToast(t("¡Wrapped de Instagram descargado!"));
    } catch (error) {
        console.error(error);
        showToast(t("No se pudo descargar la imagen del Wrapped."), "error");
    } finally {
        button.innerHTML = previous;
        button.disabled = false;
    }
}

function loadHtml2Canvas() {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = HTML2CANVAS_URL;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Image generator unavailable"));
        document.head.appendChild(script);
    });
}
