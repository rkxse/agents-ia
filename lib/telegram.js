// Telegram, par le bot du projet (NOTIF_BOT_TOKEN dans le .env du projet). Les notifications des agents au propriétaire
// (bilans, alertes, vidéos) ne passent plus par ici depuis le 01/11 : elles vont dans la conversation du panel
// (lib/boss.js note). Reste le message privé à un utilisateur, demandé par le propriétaire à l'agent patron.

// Message privé à un utilisateur du projet par le bot du projet (agent patron, à la demande du propriétaire, 01/11).
// Texte brut (pas de HTML à échapper). Renvoie { ok, error }.
async function sendTo(env, chatId, text) {
  const token = String(env.NOTIF_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, error: "pas de bot Telegram dans le .env du projet (NOTIF_BOT_TOKEN)" };
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text).slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return j.ok ? { ok: true } : { ok: false, error: j.description || "refusé (" + r.status + ")" };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { sendTo };
