// runner.js --once (lancé chaque minute par l'appareil, node.js) : un passage puis fin, dans son propre process.
// Dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

test("runner --once : un passage, état écrit, puis fin du process", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-once-"));
  try {
    const env = { ...process.env, AGENTS_RUNTIME: path.join(tmp, "data"), AGENTS_PROJECTS: path.join(tmp, "projects"), AGENTS_AUTH_DIR: path.join(tmp, "data"), AGENTS_NO_PUSH: "1" };
    const dir = path.join(tmp, "projects", "essai");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ name: "essai", dir: path.join(tmp, "src"), dataDir: "data/agents" }));
    fs.writeFileSync(path.join(dir, "agents.json"), "[]");
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "runner.js"), "--once"], { env, encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - t0 < 25000, "pas de boucle : le process se termine");
    const st = JSON.parse(fs.readFileSync(path.join(tmp, "data", "runner.json"), "utf8"));
    assert.equal(st.current, null, "aucun passage en cours une fois fini");
    assert.ok(st.beat);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Appareil qui sort de veille (02/11, portable de Scanner CVE) : 15 min sans agents à horaire, lancements demandés gardés.
test("runner --once --sans-horaire : seulement les lancements demandés", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-veille-"));
  try {
    const env = { ...process.env, AGENTS_RUNTIME: path.join(tmp, "data"), AGENTS_PROJECTS: path.join(tmp, "projects"), AGENTS_AUTH_DIR: path.join(tmp, "data"), AGENTS_NO_PUSH: "1" };
    const dir = path.join(tmp, "projects", "essai"), marks = path.join(tmp, "marques");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "src", "data", "agents"), { recursive: true });
    fs.mkdirSync(marks);
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ name: "essai", dir: path.join(tmp, "src"), dataDir: "data/agents" }));
    const every = { type: "every", minutes: 60 };
    fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify([{ id: "horaire", name: "Horaire", kind: "marque", schedule: every }, { id: "demande", name: "Demande", kind: "marque", schedule: every }]));
    fs.writeFileSync(path.join(dir, "kinds.js"), "const fs = require('fs'), path = require('path');\nmodule.exports = { kinds: { marque: async (ctx, a) => { fs.writeFileSync(path.join(" + JSON.stringify(marks) + ", a.id), 'x'); return { status: 'ok' }; } } };\n");
    const once = (...extra) => spawnSync(process.execPath, [path.join(__dirname, "..", "runner.js"), "--once", ...extra], { env, encoding: "utf8", timeout: 30000 });
    fs.mkdirSync(path.join(tmp, "data", "commands"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "commands", "1-a.json"), JSON.stringify({ project: "essai", agent: "demande", args: {}, at: new Date().toISOString(), by: "panel" }));
    let r = once("--sans-horaire");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(marks), ["demande"], "lancement demandé fait, agent à horaire reporté");
    r = once();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(marks).sort(), ["demande", "horaire"], "fin du report : l'horaire reprend");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Fil des agents (lib/team.js, 03/11) dans le vrai runner : « sante » écrit à « observation » pendant son passage ;
// au passage suivant du runner, « observation » est lancé (source : message) et reçoit le message dans sa consigne système.
test("runner : un agent écrit à un autre, qui est lancé au tour suivant avec le message", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-fil-"));
  try {
    const env = { ...process.env, AGENTS_RUNTIME: path.join(tmp, "data"), AGENTS_PROJECTS: path.join(tmp, "projects"), AGENTS_AUTH_DIR: path.join(tmp, "data"), AGENTS_NO_PUSH: "1" };
    const dir = path.join(tmp, "projects", "essai"), seen = path.join(tmp, "vu");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "src", "data", "agents"), { recursive: true });
    fs.mkdirSync(seen);
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ name: "essai", dir: path.join(tmp, "src"), dataDir: "data/agents" }));
    const demand = { type: "on-demand" };
    fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify([{ id: "sante", name: "Santé", kind: "parle", schedule: demand }, { id: "observation", name: "Observation", kind: "parle", schedule: demand }]));
    // Type d'agent sans Claude : garde la consigne d'équipe qu'il reçoit ; « sante » écrit à « observation ».
    fs.writeFileSync(path.join(dir, "kinds.js"), "const fs = require('fs'), path = require('path');\nmodule.exports = { kinds: { parle: async (ctx, a) => {\n" +
      "  fs.writeFileSync(path.join(" + JSON.stringify(seen) + ", a.id + '.txt'), ctx.team);\n" +
      "  if (a.id === 'sante') { fs.mkdirSync(ctx.D('envoi'), { recursive: true }); fs.writeFileSync(ctx.D('envoi/sante.jsonl'), JSON.stringify({ a: 'observation', texte: 'Refais ta mesure : API revenue.' }) + '\\n'); }\n" +
      "  return { status: 'ok', summary: 'passage de ' + a.id }; } } };\n");
    fs.mkdirSync(path.join(tmp, "data", "commands"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "commands", "1-a.json"), JSON.stringify({ project: "essai", agent: "sante", args: {}, at: new Date().toISOString(), by: "panel" }));
    const once = () => spawnSync(process.execPath, [path.join(__dirname, "..", "runner.js"), "--once", "--sans-horaire"], { env, encoding: "utf8", timeout: 30000 });
    let r = once();
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(seen, "sante.txt"), "utf8"), /`observation` — Observation/, "équipe présentée");
    assert.ok(!fs.existsSync(path.join(seen, "observation.txt")), "pas encore lancé");
    r = once();
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(seen, "observation.txt"), "utf8"), /de « Santé » \(`sante`\) : Refais ta mesure : API revenue\./);
    const hist = fs.readFileSync(path.join(tmp, "data", "history", "essai.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(hist.map((h) => [h.agent, h.source]), [["sante", "panel"], ["observation", "message de « Santé »"]]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("holdSchedule : démarrage et retour de veille, 15 min", () => {
  const { holdSchedule } = require("../node.js");
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(holdSchedule(now, 0, 5 * 60), "démarrage de l'ordinateur");
  assert.equal(holdSchedule(now, now - 5 * 60e3, 86400), "retour de veille");
  assert.equal(holdSchedule(now, now - 16 * 60e3, 86400), null);
  assert.equal(holdSchedule(now, 0, 86400), null);
});
