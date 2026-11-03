// Conversation avec le patron, côté appareil (node.js applyChats, lib/chat.js startRemote / remoteStatus) : la
// conversation reçue est copiée avec ses pièces jointes et le patron lancé une seule fois ; arrêt transmis ; réponse en
// cours puis terminée renvoyée au panel, copie locale effacée ensuite. Dossiers jetables, aucun Claude lancé.
// Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-rchat-dev-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const chat = require("../lib/chat");
const device = require("../node.js");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PID = "scanner", CID = "c-mbx1a2b3";
const dir = path.join(tmp, "src");
fs.mkdirSync(dir, { recursive: true });
store.writeJson(path.join(store.PROJECTS, PID, "project.json"), { name: "Scanner", dir, dataDir: "data/agents" });
const p = store.project(PID);
const FILE = path.join(store.RUNTIME, "chat", PID, CID + ".json");
const job = { project: PID, cid: CID, stop: false, conversation: { title: "Santé", created: "2026-11-02T09:00:00Z", session: "sess-1", replay: false,
  messages: [{ role: "user", text: "Tout va bien ?", at: "2026-11-02T09:00:00Z", files: [{ name: "capture.png", file: "ab-0-capture.png", type: "image/png" }] }] },
  files: [{ name: "capture.png", file: "ab-0-capture.png", type: "image/png", data: Buffer.from("png").toString("base64") }, { name: "x", file: "../evil.txt", data: "eA==" }] };

test("conversation reçue : copiée avec ses pièces jointes, patron lancé une seule fois", () => {
  const started = [];
  device.applyChats([job], (pid, cid) => started.push(pid + "/" + cid));
  assert.deepEqual(started, [PID + "/" + CID]);
  const c = store.readJson(FILE, null);
  assert.ok(c.pending);
  assert.equal(c.session, "sess-1", "session reprise");
  assert.equal(fs.readFileSync(path.join(p.data, "chat-files", CID, "ab-0-capture.png"), "utf8"), "png");
  assert.ok(!fs.existsSync(path.join(p.data, "chat-files", "evil.txt")) && !fs.existsSync(path.join(p.data, "evil.txt")), "nom de fichier dangereux ignoré");
  device.applyChats([job], (pid, cid) => started.push(pid + "/" + cid));
  assert.equal(started.length, 1, "déjà en cours : pas relancé");
});

test("arrêt demandé dans le panel : transmis au process qui répond", () => {
  device.applyChats([{ project: PID, cid: CID, stop: true }]);
  assert.ok(fs.existsSync(path.join(store.RUNTIME, "chat", PID, CID + ".stop")));
});

test("réponse en cours puis terminée : renvoyée au panel, copie locale effacée ensuite", () => {
  store.writeJson(path.join(store.RUNTIME, "chat", PID, CID + ".live.json"), { text: "Je regarde…", steps: [{ label: "Lit scanner/main.py", at: "x" }] });
  assert.deepEqual(chat.remoteStatus(p)[CID], { live: { text: "Je regarde…", steps: [{ label: "Lit scanner/main.py", at: "x" }] } });
  const c = store.readJson(FILE, null);
  c.messages.push({ role: "boss", at: "2026-11-02T09:01:00Z", text: "Tout tourne.", actions: [], seconds: 40 });
  c.pending = null;
  c.session = "sess-2";
  store.writeJson(FILE, c);
  const state = { p: {} };
  const { projects, marks } = device.collect(state, []);
  assert.equal(projects[PID].chats[CID].done.text, "Tout tourne.");
  assert.equal(projects[PID].chats[CID].done.session, "sess-2");
  assert.deepEqual(marks[PID].chatsDone, [CID]);
  chat.remoteSent(p, marks[PID].chatsDone);
  assert.ok(!fs.existsSync(FILE));
  assert.equal(device.collect(state, []).projects[PID].chats, undefined, "plus rien à renvoyer");
});
