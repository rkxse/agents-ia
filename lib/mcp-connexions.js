// Serveur MCP (stdio, JSON-RPC une ligne par message) des connexions d'un projet (lib/connections.js) : un seul outil,
// « appeler_api », que Claude Code donne aux agents et au patron (--mcp-config, lib/claude.js). Lancé avec le fichier des
// connexions du projet : c'est lui qui ajoute la valeur de l'en-tête (l'IA ne la voit jamais) et qui refuse ce qui sort
// de la connexion (autre site, chemin hors du préfixe, méthode non permise, redirection). Réponse coupée à 60 000
// caractères. Rien d'autre que le protocole sur la sortie standard.
const fs = require("fs");

const FILE = process.argv[2];
const MAX = 60000;
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { return []; } };

function tool() {
  const list = load();
  return {
    name: "appeler_api",
    description: "Appelle l'API d'un autre projet, déclarée par le propriétaire dans le panel (l'authentification est ajoutée pour toi). Connexions :\n" +
      list.map((c) => "- " + c.name + (c.description ? " : " + c.description : "") + " (" + c.baseUrl + ", chemins commençant par " + c.prefix + ", méthodes " + c.methods.join("/") + ")").join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: list.map((c) => c.name), description: "Nom de la connexion" },
        chemin: { type: "string", description: "Chemin et paramètres, commençant par le préfixe de la connexion (ex. " + ((list[0] && list[0].prefix) || "/") + "…)" },
        methode: { type: "string", enum: [...new Set(list.flatMap((c) => c.methods))], description: "GET par défaut" },
        corps: { type: "object", description: "Corps JSON (POST, PUT, PATCH)" },
      },
      required: ["service", "chemin"],
    },
  };
}

async function call(args) {
  const c = load().find((x) => x.name === args.service);
  if (!c) throw new Error("Connexion inconnue : " + args.service);
  const method = String(args.methode || "GET").toUpperCase();
  if (!c.methods.includes(method)) throw new Error("Méthode " + method + " non permise pour " + c.name + " (permises : " + c.methods.join(", ") + ").");
  const chemin = String(args.chemin || "");
  if (!chemin.startsWith("/") || chemin.startsWith("//") || /\.\.|\\|%2e|%2f|%5c/i.test(chemin.split("?")[0])) throw new Error("Chemin invalide : un chemin simple commençant par /.");
  const base = new URL(c.baseUrl), root = base.pathname.replace(/\/+$/, "");
  const url = new URL(root + chemin, base.origin), allowed = root + c.prefix;
  if (url.origin !== base.origin || !(url.pathname.startsWith(allowed) || url.pathname + "/" === allowed)) throw new Error("Chemin hors de la connexion : il doit commencer par " + c.prefix + ".");
  const headers = { Accept: "application/json", "User-Agent": "agents-ia-connexions" };
  if (c.token) headers[c.header] = c.token;
  let body;
  if (args.corps !== undefined && method !== "GET" && method !== "DELETE") { headers["Content-Type"] = "application/json"; body = JSON.stringify(args.corps); }
  const r = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30000) });
  let text = await r.text();
  // Jeton masqué s'il revient dans la réponse, avec ou sans son « Bearer ».
  for (const x of [c.token, c.token && c.token.split(/\s+/).pop()]) if (x && x.length > 3 && text.includes(x)) text = text.split(x).join("[jeton masqué]");
  if (text.length > MAX) text = text.slice(0, MAX) + "\n… (réponse coupée à " + MAX + " caractères : demande moins de résultats)";
  return { status: r.status, text };
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch (e) { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } }); }
  if (m.id === undefined || m.id === null) return; // notification (initialized, annulation…)
  const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const ko = (code, message) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  if (m.method === "initialize") return ok({ protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "connexions", version: "1.0.0" } });
  if (m.method === "ping") return ok({});
  if (m.method === "tools/list") return ok({ tools: [tool()] });
  if (m.method === "tools/call") {
    if (!m.params || m.params.name !== "appeler_api") return ko(-32602, "Outil inconnu.");
    try {
      const r = await call(m.params.arguments || {});
      return ok({ content: [{ type: "text", text: "HTTP " + r.status + "\n" + r.text }], isError: r.status >= 400 });
    } catch (e) {
      return ok({ content: [{ type: "text", text: "Erreur : " + (e.name === "TimeoutError" ? "pas de réponse en 30 s" : (e.cause && e.cause.code) || e.message) }], isError: true });
    }
  }
  return ko(-32601, "Méthode inconnue : " + m.method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line).catch((e) => process.stderr.write(String(e.stack || e) + "\n")); }
});
process.stdin.on("end", () => process.exit(0));
