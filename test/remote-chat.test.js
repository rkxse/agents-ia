// Conversation avec le patron d'un projet sur un autre appareil, côté panel (lib/chat.js, lib/nodes.js) : le message
// attend l'appareil, part à sa synchronisation avec ses pièces jointes, la réponse s'écrit en direct puis revient ; arrêt
// transmis ; l'appareil ne peut écrire que dans une conversation qui attend sa réponse ; appareil muet = réponse perdue.
// Dossiers jetables, aucun Claude lancé. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-rchat-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const nodes = require("../lib/nodes");
const chat = require("../lib/chat");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");
let node, p, cid;
const sync = (projects) => nodes.sync(node, projects ? { projects } : {});

test("message au patron d'un projet sur un appareil : il attend l'appareil, aucun process ici", () => {
  const { code } = nodes.createCode({ id: "u-lea" });
  const r = nodes.enroll({ code, name: "PC du scanner", project: { name: "Scanner", dir: "C:/scanner" } });
  node = { id: r.node.id, name: r.node.name };
  p = store.project(r.project.id);
  cid = chat.create(p).id;
  const v = chat.send(p, cid, { text: "Salut patron, tout va bien ?", files: [{ name: "capture.png", data: PNG }] });
  assert.ok(v.pending.remote);
  assert.equal(v.pending.picked, false);
  assert.equal(store.readJson(path.join(store.RUNTIME, "chat", p.id, cid + ".json"), {}).pending.pid, undefined, "aucun process lancé sur le serveur");
});

test("projet d'un autre compte sans ordinateur : son patron ne répond jamais ici (il utilise son propre Claude)", () => {
  const users = path.join(process.env.AGENTS_AUTH_DIR, "users.json");
  const before = fs.existsSync(users) ? fs.readFileSync(users, "utf8") : null;
  store.writeJson(users, [{ id: "u-admin", email: "admin@exemple.fr", name: "admin", role: "admin", status: "active" }, { id: "u-autre", email: "autre@exemple.fr", name: "autre", role: "user", status: "active" }]);
  try {
    store.writeJson(path.join(store.PROJECTS, "orphelin", "project.json"), { name: "orphelin", owner: "u-autre", dir: path.join(tmp, "src"), dataDir: "data/agents" });
    const o = store.project("orphelin");
    assert.throws(() => chat.send(o, chat.create(o).id, { text: "Salut" }), (e) => e.status === 403 && /son Claude/.test(e.message));
  } finally { if (before == null) fs.rmSync(users, { force: true }); else fs.writeFileSync(users, before); }
});

test("synchronisation : la conversation part avec ses pièces jointes, chaque seconde pendant la réponse", () => {
  const r = sync();
  assert.equal(r.interval, 1);
  const j = r.chats[0];
  assert.equal(j.cid, cid);
  assert.equal(j.conversation.messages[0].text, "Salut patron, tout va bien ?");
  assert.equal(j.files[0].data, PNG);
});

test("réponse en direct, puis seulement l'arrêt dans les synchronisations suivantes", () => {
  sync({ [p.id]: { chats: { [cid]: { live: { text: "Je regarde l'état du scanner…", steps: [{ label: "Appelle l'API scanner-cve : GET /api/v1/agent/summary", at: "2026-11-02T09:00:00Z" }] } } } } });
  const v = chat.view(p, cid);
  assert.equal(v.pending.picked, true);
  assert.equal(v.pending.live.text, "Je regarde l'état du scanner…");
  assert.equal(v.pending.live.steps.length, 1);
  assert.deepEqual(sync().chats[0], { cid, stop: false, project: p.id }, "plus de conversation ni de fichiers une fois prise");
  chat.stop(p, cid);
  assert.equal(sync().chats[0].stop, true);
});

test("réponse terminée : message du patron enregistré (champs connus seulement), session gardée", () => {
  sync({ [p.id]: { chats: { [cid]: { done: { role: "boss", text: "Tout tourne : sources à jour, aucun serveur silencieux.", actions: [{ ok: true, text: "Agent « Santé Scanner CVE » lancé", extra: 1 }],
    steps: [{ label: "Lit scanner/main.py" }], seconds: 42, session: "sess-scan-1", poison: "<script>" } } } } });
  const v = chat.view(p, cid);
  assert.equal(v.pending, null);
  const m = v.messages[v.messages.length - 1];
  assert.equal(m.role, "boss");
  assert.match(m.text, /^Tout tourne/);
  assert.deepEqual(m.actions, [{ ok: true, text: "Agent « Santé Scanner CVE » lancé" }]);
  assert.equal(m.poison, undefined);
  assert.equal(store.readJson(path.join(store.RUNTIME, "chat", p.id, cid + ".json"), {}).session, "sess-scan-1");
  assert.equal(sync().chats.length, 0);
  assert.equal(sync().interval, 5);
});

test("l'appareil n'écrit que dans une conversation qui attend sa réponse", () => {
  const n0 = chat.view(p, cid).messages.length;
  sync({ [p.id]: { chats: { [cid]: { done: { text: "Message inventé par l'appareil" } }, "c-inconnue1": { done: { text: "x" } } } } });
  assert.equal(chat.view(p, cid).messages.length, n0);
});

test("appareil muet pendant 15 min : réponse perdue, dite clairement", () => {
  const c2 = chat.create(p).id;
  chat.send(p, c2, { text: "Tu es là ?" });
  const f = path.join(store.RUNTIME, "chat", p.id, c2 + ".json"), c = store.readJson(f, {});
  c.pending.since = new Date(Date.now() - 16 * 60e3).toISOString();
  store.writeJson(f, c);
  const v = chat.view(p, c2);
  assert.equal(v.pending, null);
  assert.match(v.messages[v.messages.length - 1].error, /ordinateur du projet ne répond plus/);
});
