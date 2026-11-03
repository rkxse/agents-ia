// Lecture d'un fichier .env (clé=valeur, guillemets facultatifs, # = commentaire) sans dépendance. Ne modifie pas
// process.env : chaque projet garde ses variables (token du bot, chat de l'admin…).
const fs = require("fs");

function readEnv(file) {
  const out = {};
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch (e) { return out; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

module.exports = { readEnv };
