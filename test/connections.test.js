// Connexions des agents aux API d'autres projets (lib/connections.js) et leur serveur MCP (lib/mcp-connexions.js) :
// jeton jamais renvoyé au navigateur ni montré à l'IA, chemins limités au préfixe, lecture seule par défaut. Une fausse
// API locale joue l'autre projet. Dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-conn-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const connections = require("../lib/connections");
const { server } = require("../server");

const TOKEN = "Bearer jeton-secret-123";
const fake = http.createServer((req, res) => {
  if (req.headers.authorization !== TOKEN) { res.writeHead(401); return res.end('{"error":"jeton"}'); }
  if (req.url.startsWith("/api/v1/agent/hosts")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ hosts: [{ cve: "CVE-2026-0001", niveau: "critique", serveurs: 4 }], methode: req.method })); }
  if (req.url === "/api/v1/agent") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ routes: ["hosts"], vu: req.headers.authorization })); } // renvoie le jeton : il doit être masqué
  res.writeHead(404); res.end("{}");
});
let base, fakeBase;
test.before(() => Promise.all([
  new Promise((ok) => server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + server.address().port; ok(); })),
  new Promise((ok) => fake.listen(0, "127.0.0.1", () => { fakeBase = "http://127.0.0.1:" + fake.address().port; ok(); })),
]));
test.after(() => { server.close(); fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const req = async (method, p, body, cookie) => {
  const r = await fetch(base + p, { method, headers: { "X-Real-IP": "10.3.0.1", ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: await r.json().catch(() => null), cookie: set ? set.split(";")[0] : null };
};
const P = (id, owner, extra = {}) => { store.writeJson(path.join(store.PROJECTS, id, "project.json"), { name: id, owner, dir: path.join(tmp, "src-" + id), dataDir: "data/agents", ...extra }); return store.project(id); };

test("déclaration : nom propre, adresse vérifiée, jeton jamais renvoyé", () => {
  const p = P("veille", "u-0");
  const c = connections.add(p, { name: "Scanner CVE", description: "Scanner de CVE", baseUrl: fakeBase + "/", prefix: "api/v1/agent/", token: TOKEN });
  assert.equal(c.name, "scanner-cve");
  assert.equal(c.prefix, "/api/v1/agent/");
  assert.deepEqual(c.methods, ["GET"], "lecture seule par défaut");
  assert.equal(c.secret, "Bearer …-123");
  assert.ok(!JSON.stringify(connections.list(p)).includes("jeton-secret"));
  assert.throws(() => connections.add(p, { name: "x", baseUrl: "ftp://exemple.fr" }), /http/);
  assert.throws(() => connections.add(p, { name: "y", baseUrl: "https://moi:motdepasse@exemple.fr" }), /identifiants/);
  assert.throws(() => connections.add(p, { name: "scanner-cve", baseUrl: fakeBase }), /déjà/);
  assert.deepEqual(connections.mcpFor(P("vide", "u-0")), {}, "sans connexion : pas de serveur MCP");
  const m = connections.mcpFor(p);
  assert.deepEqual(m.mcp.tools, ["mcp__connexions__appeler_api"]);
  const cfg = JSON.parse(fs.readFileSync(m.mcp.config, "utf8")).mcpServers.connexions;
  assert.equal(cfg.args[1], connections.file("veille"));
  assert.ok(!fs.readFileSync(m.mcp.config, "utf8").includes("jeton-secret"), "pas de jeton dans la config MCP");
});

test("jeton : « Bearer » seul refusé, ajouté devant un jeton collé seul, changé sans retirer la connexion", async () => {
  const p = P("jetons", "u-0");
  assert.throws(() => connections.add(p, { name: "scanner", baseUrl: fakeBase, prefix: "/api/v1/agent/", token: "Bearer " }), /Il manque le jeton/, "02/11 : « Bearer » enregistré sans jeton");
  const c = connections.add(p, { name: "scanner", baseUrl: fakeBase, prefix: "/api/v1/agent/", token: "jeton-secret-123", bearer: true });
  assert.equal(connections.all("jetons")[0].token, TOKEN, "« Bearer » ajouté devant");
  connections.add(p, { name: "deja", baseUrl: fakeBase, token: TOKEN, bearer: true });
  assert.equal(connections.all("jetons")[1].token, TOKEN, "pas de « Bearer Bearer »");
  connections.add(p, { name: "cle", baseUrl: fakeBase, header: "X-API-Key", token: "cle-123456", bearer: true });
  assert.equal(connections.all("jetons")[2].token, "cle-123456", "« Bearer » seulement pour l'en-tête Authorization");
  // Ancienne valeur incomplète : signalée, pas affichée comme un jeton.
  connections.write("jetons", connections.all("jetons").map((x) => (x.id === c.id ? { ...x, token: "Bearer" } : x)));
  const v = connections.list(p).find((x) => x.id === c.id);
  assert.equal(v.incomplete, true);
  assert.equal(v.secret, null);
  assert.throws(() => connections.setToken(p, c.id, { token: "Bearer" }), /Il manque le jeton/);
  assert.throws(() => connections.setToken(p, c.id, { token: "  " }), /Colle le nouveau jeton/);
  const nv = connections.setToken(p, c.id, { token: "jeton-secret-123", bearer: true });
  assert.equal(nv.incomplete, false);
  assert.equal(nv.secret, "Bearer …-123");
  // Essai : sans la barre finale quand l'API ne connaît que /api/v1/agent ; jeton masqué dans ce qui revient.
  const t = await connections.test(p, c.id);
  assert.equal(t.status, 200);
  assert.match(t.sample, /routes/);
  assert.ok(!t.sample.includes("jeton-secret"), "jeton masqué dans l'essai");
  // Projet d'un appareil : l'essai est fait par l'appareil (node.js answer).
  const [r] = await require("../node").answer([{ id: "r1", type: "connexion", project: "jetons", conn: c.id }]);
  assert.equal(r.result.status, 200);
  assert.ok(!JSON.stringify(r).includes("jeton-secret"));
});

test("serveur MCP : l'outil appelle l'API avec le jeton, refuse ce qui sort de la connexion", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "lib", "mcp-connexions.js"), connections.file("veille")], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", n = 0;
  const waiting = new Map();
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)(m); } });
  const rpc = (method, params) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const callTool = async (args) => (await rpc("tools/call", { name: "appeler_api", arguments: args })).result;
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "connexions");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const t = (await rpc("tools/list", {})).result.tools[0];
    assert.equal(t.name, "appeler_api");
    assert.deepEqual(t.inputSchema.properties.service.enum, ["scanner-cve"]);
    assert.ok(!JSON.stringify(t).includes("jeton-secret"), "l'IA ne voit pas le jeton");
    const ok = await callTool({ service: "scanner-cve", chemin: "/api/v1/agent/hosts?limit=5" });
    assert.equal(ok.isError, false);
    assert.match(ok.content[0].text, /^HTTP 200\n.*CVE-2026-0001/s);
    for (const [args, why] of [
      [{ service: "scanner-cve", chemin: "/api/v1/admin/users" }, /hors de la connexion/],
      [{ service: "scanner-cve", chemin: "//autre-site.fr/api/v1/agent/x" }, /Chemin invalide/],
      [{ service: "scanner-cve", chemin: "/api/v1/agent/../admin" }, /Chemin invalide/],
      [{ service: "scanner-cve", chemin: "/api/v1/agent/hosts", methode: "POST", corps: {} }, /non permise/],
      [{ service: "autre", chemin: "/api/v1/agent/hosts" }, /inconnue/],
    ]) {
      const r = await callTool(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.content[0].text, why);
    }
    assert.equal((await rpc("inconnue", {})).error.code, -32601);
  } finally { child.kill(); }
});

test("panel : le propriétaire gère et teste ses connexions ; les autres ne voient rien", async () => {
  const a = await req("POST", "/api/auth/signup", { email: "ana@exemple.fr", password: "secret123" });
  const b = await req("POST", "/api/auth/signup", { email: "ben@exemple.fr", password: "secret123" });
  P("site-ana", a.json.user.id);
  P("pc-ana", a.json.user.id, { node: "n-test" });
  const add = await req("POST", "/api/projects/site-ana/connections", { name: "scanner", baseUrl: fakeBase, prefix: "/api/v1/agent/hosts", token: TOKEN }, a.cookie);
  assert.equal(add.status, 200);
  const list = await req("GET", "/api/projects/site-ana/connections", null, a.cookie);
  assert.equal(list.json.connections.length, 1);
  assert.ok(!JSON.stringify(list.json).includes("jeton-secret"));
  assert.equal((await req("GET", "/api/projects/site-ana/connections", null, b.cookie)).status, 404, "projet d'un autre compte");
  const t = await req("POST", "/api/projects/site-ana/connections/" + add.json.connection.id + "/test", {}, a.cookie);
  assert.equal(t.json.status, 200);
  assert.match(t.json.sample, /CVE-2026-0001/);
  const add2 = await req("POST", "/api/projects/pc-ana/connections", { name: "local", baseUrl: "http://127.0.0.1:8080" }, a.cookie);
  assert.equal((await req("POST", "/api/projects/pc-ana/connections/" + add2.json.connection.id + "/test", {}, a.cookie)).status, 503, "projet d'un appareil : essayé par l'appareil, ici hors ligne");
  assert.equal((await req("POST", "/api/projects/pc-ana/connections/x-00000000/test", {}, a.cookie)).status, 404);
  const tk = await req("POST", "/api/projects/site-ana/connections/" + add.json.connection.id + "/token", { token: "Bearer" }, a.cookie);
  assert.equal(tk.status, 400);
  assert.equal((await req("POST", "/api/projects/site-ana/connections/" + add.json.connection.id + "/token", { token: "jeton-secret-123", bearer: true }, b.cookie)).status, 404, "pas le jeton d'un autre");
  const tk2 = await req("POST", "/api/projects/site-ana/connections/" + add.json.connection.id + "/token", { token: "jeton-secret-123", bearer: true }, a.cookie);
  assert.equal(tk2.status, 200);
  assert.ok(!JSON.stringify(tk2.json).includes("jeton-secret"));
  assert.equal((await req("POST", "/api/projects/site-ana/connections/" + add.json.connection.id + "/delete", {}, a.cookie)).status, 200);
  assert.equal(connections.all("site-ana").length, 0);
});
