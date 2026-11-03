// Alertes de l'accueil marquées « Vu » (server.js /api/alerts/seen) : cachées pour ce compte seulement, jusqu'au bilan
// suivant de l'agent ; jamais sur le projet d'un autre compte. Dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-vues-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const { server } = require("../server");

let base;
test.before(() => new Promise((ok) => server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + server.address().port; ok(); })));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const req = async (method, p, body, cookie) => {
  const r = await fetch(base + p, { method, headers: { "X-Real-IP": "10.4.0.1", ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: await r.json().catch(() => null), cookie: set ? set.split(";")[0] : null };
};

test("« Vu » cache l'alerte pour ce compte jusqu'au bilan suivant", async () => {
  const a = await req("POST", "/api/auth/signup", { email: "vue@exemple.fr", password: "secret123" });
  const b = await req("POST", "/api/auth/signup", { email: "autre@exemple.fr", password: "secret123" });
  store.writeJson(path.join(store.PROJECTS, "vue", "project.json"), { name: "vue", owner: a.json.user.id, dir: path.join(tmp, "src"), dataDir: "data/agents" });
  store.writeAgents("vue", [{ id: "guet", name: "Guetteur", kind: "custom", enabled: true, schedule: { type: "on-demand" }, prompt: "prompts/guet.md" }]);
  const p = store.project("vue");
  store.setLastRun(p, "guet", { lastAt: "2026-11-02T10:00:00.000Z", lastStatus: "attention", lastSummary: "service arrêté" });
  const alerts = async (c) => (await req("GET", "/api/overview", null, c)).json.alerts.filter((x) => x.agent === "guet");
  const [al] = await alerts(a.cookie);
  assert.ok(al, "alerte affichée");
  assert.equal((await req("POST", "/api/alerts/seen", { project: "vue", agent: "guet", at: al.at }, b.cookie)).status, 404, "pas le projet d'un autre");
  assert.equal((await req("POST", "/api/alerts/seen", { project: "vue", agent: "guet", at: al.at }, a.cookie)).status, 200);
  assert.equal((await alerts(a.cookie)).length, 0, "cachée");
  store.setLastRun(p, "guet", { lastAt: "2026-11-02T14:00:00.000Z", lastStatus: "attention", lastSummary: "service encore arrêté" });
  assert.equal((await alerts(a.cookie)).length, 1, "bilan suivant : de nouveau affichée");
});
