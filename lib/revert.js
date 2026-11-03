// Annulation d'un changement demandée depuis le panel (onglet Changements, 01/11), faite par le runner sous le verrou
// du projet : patch inverse du commit, puis tests, commit et redémarrage (git-guard), sinon tout est remis comme avant.
// Résultat dans les notifications du panel et l'historique des passages (agent « annulation »).
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("./store");
const G = require("./git-guard");

async function revertCommit(p, ctx, hash) {
  const t0 = Date.now();
  const git = (...a) => spawnSync("git", a, { cwd: p.dir, encoding: "utf8", windowsHide: true });
  const ok = /^[0-9a-f]{7,40}$/.test(hash);
  const subject = ok ? (git("log", "-1", "--format=%s", hash).stdout || "").trim().slice(0, 100) : "";
  const short = String(hash).slice(0, 7);
  let status = "erreur", summary, commit = null;
  // Seuls les fichiers de ce changement comptent (03/11 : avant, le moindre travail en cours ailleurs dans le dépôt
  // bloquait l'annulation) : s'ils sont en cours de modification, l'annuler mélangerait ce travail au commit.
  const files = ok ? (git("show", "--name-only", "--format=", hash).stdout || "").split(/\r?\n/).filter(Boolean) : [];
  const busy = ctx.busy().filter((f) => files.includes(f));
  if (!ok || !subject) summary = "commit introuvable";
  else if (busy.length) summary = "fichiers de ce changement en cours de modification (" + busy.join(", ").slice(0, 200) + ") : rien n'a été touché";
  else {
    const before = ctx.untrackedSet();
    const patch = spawnSync("git", ["show", "--format=", "--binary", hash], { cwd: p.dir, maxBuffer: 50 * 1024 * 1024, windowsHide: true }).stdout;
    const r = spawnSync("git", ["apply", "-R", "--whitespace=nowarn"], { cwd: p.dir, input: patch, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) summary = "le code a changé depuis ce commit, l'annulation ne s'applique plus proprement : rien n'a été touché (" + (r.stderr || "").trim().slice(0, 160) + ")";
    else {
      const applied = ctx.applyChanges(before, "Annulation de " + short + " : " + subject, ["Demandée depuis le panel (onglet Changements)."],
        { allowed: G.zone("^(?!data/|\\.env|node_modules/|\\.git/)"), maxLines: 0, trailer: "Agent · annulation demandée depuis le panel (goldpilot-agents)." });
      commit = applied.commit;
      if (commit) { status = "ok"; summary = "changement " + short + " annulé (" + commit + "), tests verts" + (p.restartCmd ? ", projet redémarré" : ""); }
      else summary = applied.testsFailed ? "des tests échouaient sans ce changement : annulation abandonnée, le code reste comme avant" : "annulation impossible";
    }
  }
  await ctx.notify("↩️ Annulation de « " + subject + " » (" + short + ") · " + p.name + "\n\n" + (status === "ok" ? "✅ " : "❌ ") + summary);
  store.append(path.join(store.RUNTIME, "history", p.id + ".jsonl"), { at: new Date().toISOString(), agent: "annulation", source: "panel", status, summary, commit, seconds: Math.round((Date.now() - t0) / 1000) });
  return { status, summary, commit };
}

module.exports = { revertCommit };
