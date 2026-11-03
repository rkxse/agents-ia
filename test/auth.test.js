// Comptes du panel (lib/auth.js, server.js) par de vraies requêtes HTTP : rien sans session, chacun ne voit que ses
// projets, compte administrateur réclamé une seule fois, essais limités. Comptes dans un dossier jetable
// (AGENTS_AUTH_DIR) ; seules des lectures sont faites sur les vrais projets. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AGENTS_AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gp-auth-"));
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../lib/auth");
const { server } = require("../server");

let base;
test.before(() => new Promise((ok) => server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + server.address().port; ok(); })));
test.after(() => { server.close(); fs.rmSync(process.env.AGENTS_AUTH_DIR, { recursive: true, force: true }); });
const req = async (method, p, body, cookie, ip) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), "X-Real-IP": ip || "10.0.0.1" }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: await r.json().catch(() => null), cookie: set ? set.split(";")[0] : null, set };
};

test("sans session : la page oui, les données non", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  for (const p of ["/api/nav", "/api/overview", "/api/projects/exemple", "/api/projects/exemple/chats", "/chat-files/exemple/c-abcd/x.png", "/media/exemple/video/1/apercu.png"]) assert.equal((await req("GET", p)).status, 401, p);
  assert.equal((await req("GET", "/api/auth/me")).status, 401);
});

test("compte administrateur : code à usage unique, puis ses projets", async () => {
  const code = auth.setupCode();
  assert.equal((await req("POST", "/api/auth/setup", { code: "faux", email: "admin@exemple.fr", password: "motdepasse1" })).status, 403);
  const r = await req("POST", "/api/auth/setup", { code, email: "admin@exemple.fr", password: "motdepasse1", name: "Patron" });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, "admin");
  assert.match(r.set, /HttpOnly/);
  assert.match(r.set, /SameSite=Lax/);
  assert.equal((await req("POST", "/api/auth/setup", { code, email: "autre@exemple.fr", password: "motdepasse1" })).status, 403, "code déjà utilisé");
  const nav = await req("GET", "/api/nav", null, r.cookie);
  assert.ok(nav.json.projects.some((p) => p.id === "exemple"), "projets d'avant les comptes : à l'administrateur");
});

test("nouvel utilisateur : rien d'autre que ses projets", async () => {
  const s = await req("POST", "/api/auth/signup", { email: "Lea@Exemple.fr", password: "secret123", name: "Léa" });
  assert.equal(s.status, 200);
  assert.equal(s.json.user.role, "user");
  assert.equal(s.json.user.email, "lea@exemple.fr");
  const nav = await req("GET", "/api/nav", null, s.cookie);
  assert.deepEqual(nav.json.projects, []);
  for (const p of ["/api/projects/exemple", "/api/projects/exemple/chats", "/api/projects/exemple/timeline", "/api/projects/exemple/graph", "/api/projects/exemple/notes"]) assert.equal((await req("GET", p, null, s.cookie)).status, 404, p);
  assert.equal((await req("POST", "/api/projects/exemple/agents/scout/run", {}, s.cookie)).status, 404);
  assert.equal((await req("POST", "/api/projects", { name: "x", dir: "C:/" }, s.cookie)).status, 403, "pas de projet sur le serveur");
  assert.equal((await req("GET", "/api/admin/users", null, s.cookie)).status, 403);
  assert.equal((await req("POST", "/api/auth/signup", { email: "lea@exemple.fr", password: "autre1234" }, null, "10.0.0.2")).status, 400, "adresse déjà prise");
  assert.equal((await req("POST", "/api/auth/signup", { email: "pas-une-adresse", password: "secret123" }, null, "10.0.0.2")).status, 400);
  assert.equal((await req("POST", "/api/auth/signup", { email: "court@exemple.fr", password: "1234" }, null, "10.0.0.2")).status, 400);
});

test("connexion, déconnexion, compte bloqué", async () => {
  assert.equal((await req("POST", "/api/auth/login", { email: "lea@exemple.fr", password: "mauvais" }, null, "10.0.0.3")).status, 401);
  const l = await req("POST", "/api/auth/login", { email: "LEA@exemple.fr", password: "secret123" }, null, "10.0.0.3");
  assert.equal(l.status, 200);
  assert.equal((await req("GET", "/api/auth/me", null, l.cookie)).status, 200);
  await req("POST", "/api/auth/logout", {}, l.cookie);
  assert.equal((await req("GET", "/api/auth/me", null, l.cookie)).status, 401, "session effacée");
  const a = await req("POST", "/api/auth/login", { email: "admin@exemple.fr", password: "motdepasse1" }, null, "10.0.0.3");
  const lea = (await req("GET", "/api/admin/users", null, a.cookie)).json.users.find((u) => u.email === "lea@exemple.fr");
  const l2 = await req("POST", "/api/auth/login", { email: "lea@exemple.fr", password: "secret123" }, null, "10.0.0.3");
  assert.equal((await req("POST", "/api/admin/users/" + lea.id + "/status", { status: "blocked" }, a.cookie)).status, 200);
  assert.equal((await req("GET", "/api/nav", null, l2.cookie)).status, 401, "sessions du compte bloqué fermées");
  assert.equal((await req("POST", "/api/auth/login", { email: "lea@exemple.fr", password: "secret123" }, null, "10.0.0.4")).status, 403);
});

test("essais limités : 10 mauvais mots de passe puis blocage", async () => {
  for (let i = 0; i < 10; i++) await req("POST", "/api/auth/login", { email: "admin@exemple.fr", password: "x" + i }, null, "10.9.9.9");
  assert.equal((await req("POST", "/api/auth/login", { email: "admin@exemple.fr", password: "motdepasse1" }, null, "10.9.9.9")).status, 429);
});
