// API pour les autres projets (/api/v1, lib/apikeys.js) par de vraies requêtes HTTP : clé obligatoire (jamais le cookie
// du panel), seulement les projets du propriétaire (ou ceux choisis), droits, limites, clé retirée, aucun coût montré.
// Comptes et projets dans des dossiers jetables ; aucun Claude lancé. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-api-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const apikeys = require("../lib/apikeys");
const { server } = require("../server");

let base;
test.before(() => new Promise((ok) => server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + server.address().port; ok(); })));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const req = async (method, p, body, { key, cookie, ip, type } = {}) => {
  const headers = { "X-Real-IP": ip || "10.2.0.1", ...(body ? { "Content-Type": type || "application/json" } : {}), ...(key ? { Authorization: "Bearer " + key } : {}), ...(cookie ? { Cookie: cookie } : {}) };
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: await r.json().catch(() => null), cookie: set ? set.split(";")[0] : null };
};
function project(id, owner, extra = {}) {
  store.writeJson(path.join(store.PROJECTS, id, "project.json"), { name: "Projet " + id, owner, dir: path.join(tmp, "src-" + id), dataDir: "data/agents", ...extra });
  store.writeAgents(id, [{ id: "scout", name: "Éclaireur", kind: "scout", enabled: true, schedule: { type: "on-demand" } }]);
}

const K = {};
let lea, leaCookie;
test("préparation : deux comptes et leurs projets", async () => {
  const a = await req("POST", "/api/auth/signup", { email: "lea@exemple.fr", password: "secret123", name: "Léa" }, { ip: "10.2.1.1" });
  const b = await req("POST", "/api/auth/signup", { email: "bob@exemple.fr", password: "secret123" }, { ip: "10.2.1.2" });
  lea = a.json.user; leaCookie = a.cookie;
  project("site-lea", lea.id); project("bot-lea", lea.id); project("pc-lea", lea.id, { node: "n-test" }); project("app-bob", b.json.user.id);
});

test("clé créée dans le panel : mot de passe demandé, montrée une seule fois, jamais son empreinte", async () => {
  assert.equal((await req("POST", "/api/me/api-keys", { name: "Scanner", password: "faux" }, { cookie: leaCookie })).status, 403, "403 et non 401 : la page ne doit pas croire la session expirée");
  const r = await req("POST", "/api/me/api-keys", { name: "Scanner CVE", scopes: ["lire", "notifier"], password: "secret123" }, { cookie: leaCookie });
  assert.equal(r.status, 200);
  assert.match(r.json.secret, /^agk_[A-Za-z0-9_-]{30,}$/);
  K.read = r.json.secret;
  const l = await req("GET", "/api/me/api-keys", null, { cookie: leaCookie });
  assert.equal(l.json.keys.length, 1);
  assert.deepEqual(l.json.keys[0].scopes, ["lire", "notifier"]);
  assert.ok(!JSON.stringify(l.json).includes(K.read.slice(12)) && !JSON.stringify(l.json).includes("hash"), "ni la clé ni son empreinte");
  assert.deepEqual(l.json.projects.map((p) => p.id).sort(), ["bot-lea", "pc-lea", "site-lea"]);
  K.all = apikeys.create(lea, { name: "tout", scopes: apikeys.SCOPES }, ["site-lea", "bot-lea", "pc-lea"]).secret;
  K.one = apikeys.create(lea, { name: "un projet", scopes: ["lire"], projects: ["site-lea"] }, ["site-lea", "bot-lea", "pc-lea"]).secret;
  assert.throws(() => apikeys.create(lea, { scopes: ["lire"], projects: ["app-bob"] }, ["site-lea"]), /Projet inconnu/);
});

test("sans clé, clé fausse ou seulement le cookie du panel : rien", async () => {
  assert.equal((await req("GET", "/api/v1")).status, 401);
  assert.equal((await req("GET", "/api/v1/projects", null, { cookie: leaCookie })).status, 401, "le cookie n'ouvre pas l'API");
  assert.equal((await req("GET", "/api/v1", null, { key: "agk_" + "x".repeat(32) })).status, 401);
  assert.equal((await req("POST", "/api/v1/projects/site-lea/notifications", { text: "x" }, { key: K.read, type: "text/plain" })).status, 415);
});

test("une clé ne voit que les projets de son propriétaire, ou ceux choisis", async () => {
  const me = await req("GET", "/api/v1", null, { key: K.read });
  assert.equal(me.json.user.email, "lea@exemple.fr");
  assert.deepEqual(me.json.key.scopes, ["lire", "notifier"]);
  assert.deepEqual((await req("GET", "/api/v1/projects", null, { key: K.read })).json.projects.map((p) => p.id).sort(), ["bot-lea", "pc-lea", "site-lea"]);
  assert.equal((await req("GET", "/api/v1/projects/app-bob", null, { key: K.all })).status, 404, "projet d'un autre compte");
  assert.deepEqual((await req("GET", "/api/v1/projects", null, { key: K.one })).json.projects.map((p) => p.id), ["site-lea"]);
  assert.equal((await req("GET", "/api/v1/projects/bot-lea", null, { key: K.one })).status, 404, "projet non choisi pour cette clé");
  const p = await req("GET", "/api/v1/projects/site-lea", null, { key: K.one });
  assert.equal(p.json.agents[0].id, "scout");
  assert.ok(!/cost|dir"|passHash|token/i.test(JSON.stringify(p.json)), "ni coût, ni dossier, ni secret");
});

test("droits : chaque action demande le sien", async () => {
  assert.equal((await req("POST", "/api/v1/projects/site-lea/agents/scout/run", {}, { key: K.read })).status, 403);
  assert.equal((await req("POST", "/api/v1/projects/site-lea/boss", { text: "salut" }, { key: K.read })).status, 403);
  assert.equal((await req("POST", "/api/v1/projects/site-lea/notifications", { text: "x" }, { key: K.one })).status, 403);
  const n = await req("POST", "/api/v1/projects/site-lea/notifications", { title: "Nouvelle CVE critique", text: "OpenSSL sur 4 serveurs", level: "urgent" }, { key: K.read });
  assert.equal(n.status, 200);
  const list = (await req("GET", "/api/v1/projects/site-lea/notifications", null, { key: K.read })).json.notifications;
  assert.match(list[list.length - 1].text, /^🚨 Nouvelle CVE critique\nOpenSSL/);
  assert.equal(list[list.length - 1].source, "api");
});

test("lancer un agent : demande mise en file pour le runner", async () => {
  const r = await req("POST", "/api/v1/projects/site-lea/agents/scout/run", {}, { key: K.all });
  assert.equal(r.status, 200);
  assert.equal(r.json.queued, true);
  const cmds = fs.readdirSync(path.join(store.RUNTIME, "commands")).map((f) => store.readJson(path.join(store.RUNTIME, "commands", f), {}));
  assert.ok(cmds.some((c) => c.project === "site-lea" && c.agent === "scout"));
  assert.equal((await req("POST", "/api/v1/projects/site-lea/agents/inconnu/run", {}, { key: K.all })).status, 404);
});

test("passages des agents, et patron d'un projet sur un autre appareil (réponse attendue de l'appareil)", async () => {
  store.append(path.join(store.RUNTIME, "history", "site-lea.jsonl"), { at: "2026-11-02T08:00:00.000Z", agent: "scout", status: "ok", summary: "3 pistes", cost: 0.4, seconds: 30 });
  const r = await req("GET", "/api/v1/projects/site-lea/runs?since=2026-11-01T00:00:00Z", null, { key: K.read });
  assert.equal(r.json.runs[0].summary, "3 pistes");
  assert.equal(r.json.runs[0].cost, undefined, "pas de coût");
  assert.equal((await req("POST", "/api/v1/projects/pc-lea/boss", { text: "  " }, { key: K.all })).status, 400, "message vide refusé");
  const b = await req("POST", "/api/v1/projects/pc-lea/boss", { text: "salut" }, { key: K.all });
  assert.equal(b.status, 200);
  assert.equal(b.json.pending, true, "la réponse viendra de l'appareil");
  assert.equal((await req("GET", "/api/v1/projects/pc-lea/boss/" + b.json.conversation, null, { key: K.read })).json.pending, true);
  assert.equal((await req("GET", "/api/v1/projects/site-lea/boss", null, { key: K.read })).status, 200);
});

test("limites : 30 notifications par minute et par clé ; clé retirée = plus rien", async () => {
  let last;
  for (let i = 0; i < 30; i++) last = await req("POST", "/api/v1/projects/bot-lea/notifications", { text: "n" + i }, { key: K.all });
  assert.equal(last.status, 200);
  assert.equal((await req("POST", "/api/v1/projects/bot-lea/notifications", { text: "de trop" }, { key: K.all })).status, 429);
  const id = (await req("GET", "/api/me/api-keys", null, { cookie: leaCookie })).json.keys.find((k) => k.name === "Scanner CVE").id;
  assert.equal((await req("POST", "/api/me/api-keys/" + id + "/delete", {}, { cookie: leaCookie })).status, 200);
  assert.equal((await req("GET", "/api/v1", null, { key: K.read })).status, 401);
});
