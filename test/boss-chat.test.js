// Conversations avec l'agent patron (lib/chat.js, lib/boss.js) : réponse lue, plusieurs conversations, recherche,
// pièces jointes, notifications des agents, actions à blanc. Projet fictif : seuls ses fichiers (data/chat/zz-essai*,
// data/zz-essai) sont écrits, puis effacés ; aucun patron n'est lancé. Lancer : npm test
process.env.AGENTS_NO_PUSH = "1"; // les notifications d'essai ne partent jamais sur le téléphone
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const store = require("../lib/store");
const boss = require("../lib/boss");
const chat = require("../lib/chat");

const p = { id: "zz-essai", name: "Essai", dir: path.join(store.RUNTIME, "zz-essai"), data: path.join(store.RUNTIME, "zz-essai", "data") };
const clean = () => {
  for (const f of [path.join(store.RUNTIME, "chat", "zz-essai"), path.join(store.RUNTIME, "chat", "zz-essai.notes.jsonl"), p.dir]) fs.rmSync(f, { recursive: true, force: true });
};
test.before(clean);
test.after(clean);

test("réponse : texte affiché sans le bloc d'actions, actions lues", () => {
  const r = boss.parseReply("C'est fait.\n\n<actions>[{\"type\":\"regler\",\"agent\":\"video\",\"enabled\":false}]</actions>");
  assert.equal(r.shown, "C'est fait.");
  assert.deepEqual(r.list, [{ type: "regler", agent: "video", enabled: false }]);
  assert.equal(r.bad, false);
  assert.equal(boss.parseReply("Ok <actions>```json\n{\"type\":\"lancer\",\"agent\":\"scout\"}\n```</actions>").list[0].agent, "scout", "bloc entre ``` et objet seul");
  assert.equal(boss.parseReply("Ok <actions>[pas du json]</actions>").bad, true);
  assert.deepEqual(boss.parseReply("Juste une réponse.").list, []);
});

test("plusieurs conversations : création, titre, recherche, renommer, supprimer", () => {
  const a = chat.create(p), b = chat.create(p);
  assert.notEqual(a.id, b.id);
  assert.equal(a.title, "Nouvelle conversation");
  // Un message sans patron lancé : on écrit directement la conversation comme le ferait send, sans process.
  const file = path.join(store.RUNTIME, "chat", p.id, a.id + ".json");
  const c = store.readJson(file);
  c.messages.push({ role: "user", text: "Pourquoi le compte de Zoé refuse les ordres ?", at: new Date().toISOString() });
  c.title = "Compte de Zoé";
  store.writeJson(file, c);
  assert.equal(chat.list(p).length, 2);
  assert.deepEqual(chat.list(p, "zoe").map((x) => x.id), [a.id], "recherche sans accents, dans le titre");
  const hit = chat.list(p, "refuse les ordres")[0];
  assert.equal(hit.id, a.id);
  assert.match(hit.match || chat.list(p, "ordres")[0].title, /ordres|Zoé/);
  assert.equal(chat.rename(p, b.id, "  Essai renommé ").title, "Essai renommé");
  chat.remove(p, b.id);
  assert.deepEqual(chat.list(p).map((x) => x.id), [a.id]);
  assert.throws(() => chat.view(p, "c-inconnue"), /inconnue/);
  assert.throws(() => chat.view(p, "../../secret"), /inconnue/);
});

test("pièce jointe : enregistrée dans le projet, types et taille contrôlés", () => {
  const a = chat.create(p);
  assert.throws(() => chat.send(p, a.id, { text: "x", files: [{ name: "virus.exe", data: "AAAA" }] }), /non accepté/);
  assert.throws(() => chat.send(p, a.id, { text: "x", files: [{ name: "page.html", data: "AAAA" }] }), /non accepté/);
  assert.throws(() => chat.send(p, a.id, { text: "", files: [] }), /Écris ton message/);
  assert.throws(() => chat.filePath(p, a.id, "../../.env"), /inconnu/);
});

test("notifications des agents : fil à part, dernière date", () => {
  chat.note(p, "🛠️ Agent de correction · 2 messages vérifiés");
  chat.note(p, "🎬 Vidéo TikTok à valider", { video: "2026-11-01-10-00" });
  const n = chat.notes(p);
  assert.equal(n.length, 2);
  assert.equal(n[1].video, "2026-11-01-10-00");
  assert.equal(chat.lastNote(p), n[1].at);
});

test("étapes affichées en direct : en mots simples", () => {
  const q = { dir: "C:/proj" };
  assert.equal(chat.stepLabel(q, { name: "Read", input: { file_path: "C:\\proj\\src\\trading\\trader.js" } }), "Lit src/trading/trader.js");
  assert.equal(chat.stepLabel(q, { name: "PowerShell", input: { command: "npm test" } }), "Lance les tests");
  assert.match(chat.stepLabel(q, { name: "PowerShell", input: { command: "gp-query users" } }), /^Interroge la base/);
  assert.match(chat.stepLabel(q, { name: "WebSearch", input: { query: "tradingview websocket" } }), /^Cherche sur le web/);
});

test("actions à blanc : contrôlées, rien d'envoyé ni d'écrit", async () => {
  const out = await boss.applyActions(p, null, [{ type: "message", telegram_id: "123456789", nom: "Zoé", texte: "Salut" }, { type: "message", telegram_id: "abc", texte: "x" },
    { type: "lancer", agent: "inconnu" }, { type: "commit", titre: "x" }], { dryRun: true });
  assert.deepEqual(out.map((x) => x.ok), [true, false, false]);
  assert.equal(out[0].text, "Message envoyé à Zoé");
});
