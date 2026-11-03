// Notifications push sur le téléphone du propriétaire (demande du 01/11 : « alertes sur le téléphone », après l'arrêt
// des notifications Telegram). Le panel s'installe comme une app (public/sw.js, manifeste) ; chaque notification des
// agents (lib/chat.js note) part aussi en push vers les appareils où elles sont activées.
// Protocole Web Push standard sans dépendance (crypto de Node) : clés VAPID (RFC 8292, jeton ES256) et contenu chiffré
// aes128gcm (RFC 8291). Android / Chrome / Edge / Firefox, iPhone avec le panel ajouté à l'écran d'accueil (iOS 16.4+).
// Clés et abonnements : data/push.json (non suivi). Seuls les services push connus sont acceptés (le serveur n'envoie
// rien ailleurs) ; un abonnement refusé (404 / 410) est retiré. Un envoi raté ne bloque jamais rien.
const crypto = require("crypto");
const path = require("path");
const store = require("./store");

const FILE = path.join(store.RUNTIME, "push.json");
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const MAX_SUBS = 10;
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function state() {
  const s = store.readJson(FILE, null);
  if (s && s.keys) return s;
  // Clés VAPID créées au premier usage (changer de clés oblige chaque appareil à réactiver les notifications).
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const fresh = { keys: { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) }, subs: [] };
  store.writeJson(FILE, fresh);
  return fresh;
}
const publicKey = () => state().keys.publicKey;
// Appareils d'un utilisateur (abonnement sans uid : d'avant les comptes, celui de l'administrateur).
const ownerOf = (s) => s.uid || (require("./auth").admin() || {}).id;
const count = (uid) => (store.readJson(FILE, { subs: [] }).subs || []).filter((s) => !uid || ownerOf(s) === uid).length;

function validSub(sub) {
  if (!sub || typeof sub !== "object" || !sub.keys) return false;
  let u;
  try { u = new URL(String(sub.endpoint || "")); } catch (e) { return false; }
  return u.protocol === "https:" && String(sub.endpoint).length <= 1000 && PUSH_HOSTS.some((re) => re.test(u.hostname)) &&
    /^[A-Za-z0-9_-]{80,100}={0,2}$/.test(String(sub.keys.p256dh || "")) && /^[A-Za-z0-9_-]{16,30}={0,2}$/.test(String(sub.keys.auth || ""));
}
function subscribe(sub, device, uid) {
  if (!validSub(sub)) throw Object.assign(new Error("Abonnement aux notifications invalide ou service push inconnu."), { status: 400 });
  const s = state();
  s.subs = s.subs.filter((x) => x.endpoint !== sub.endpoint);
  s.subs.push({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, uid: uid || null, at: new Date().toISOString(), device: String(device || "").slice(0, 120) });
  // Au plus MAX_SUBS appareils par utilisateur (les plus récents).
  const keep = new Set(s.subs.filter((x) => ownerOf(x) === ownerOf(s.subs[s.subs.length - 1])).slice(-MAX_SUBS).map((x) => x.endpoint));
  s.subs = s.subs.filter((x) => ownerOf(x) !== ownerOf(s.subs[s.subs.length - 1]) || keep.has(x.endpoint));
  store.writeJson(FILE, s);
}
function unsubscribe(endpoint, uid) {
  const s = state();
  s.subs = s.subs.filter((x) => !(x.endpoint === endpoint && (!uid || ownerOf(x) === uid)));
  store.writeJson(FILE, s);
}

// Jeton VAPID (ES256) pour le service push de l'abonnement.
function vapidHeader(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:admin@rvkxse.com" }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: keys.privatePem, dsaEncoding: "ieee-p1363" });
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + keys.publicKey;
}
// Contenu chiffré pour un abonnement (RFC 8291, un seul enregistrement aes128gcm).
function encrypt(sub, payload) {
  const ua = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const as = ecdh.generateKeys();
  const shared = ecdh.computeSecret(ua);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ua, as, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([as.length]), as, body]);
}

// Envoie aux appareils de l'utilisateur uid. Renvoie le nombre d'envois réussis (jamais d'exception).
async function send({ title, body, url, tag, uid }) {
  let s;
  try { s = state(); } catch (e) { return 0; }
  const subs = s.subs.filter((x) => uid && ownerOf(x) === uid);
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title: String(title || "Agents IA").slice(0, 120), body: String(body || "").slice(0, 500), url: url || "/", tag: tag || undefined });
  const gone = [];
  let ok = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      const r = await fetch(sub.endpoint, { method: "POST", body: encrypt(sub, payload), signal: AbortSignal.timeout(15000),
        headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high", Authorization: vapidHeader(sub.endpoint, s.keys) } });
      if (r.ok) ok++;
      else if (r.status === 404 || r.status === 410) gone.push(sub.endpoint);
      else console.warn("[push] refusé (" + new URL(sub.endpoint).hostname + ") : " + r.status + " " + (await r.text()).slice(0, 160));
    } catch (e) { console.warn("[push] envoi impossible : " + e.message); }
  }));
  if (gone.length) { const f = state(); f.subs = f.subs.filter((x) => !gone.includes(x.endpoint)); store.writeJson(FILE, f); }
  return ok;
}

module.exports = { publicKey, count, subscribe, unsubscribe, send, encrypt, vapidHeader, validSub };
