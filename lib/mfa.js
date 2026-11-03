// Double authentification des comptes du panel (demande du 01/11 : « chaque user doit pouvoir changer son mot de passe,
// ajouter MFA et clé physique »), sans dépendance :
//  - application d'authentification (TOTP, RFC 6238 : Google Authenticator, Authy, 1Password…) et codes de secours
//    (usage unique, gardés en empreinte) ;
//  - clés de sécurité et clés d'accès (WebAuthn : YubiKey, Windows Hello, Touch ID, Face ID…), en second facteur.
//    Attestation « none » (on ne vérifie pas le modèle de la clé), signatures ES256, RS256 et EdDSA, compteur de
//    signatures contrôlé (clé clonée refusée). Origine et domaine attendus : PANEL_ORIGINS (défaut agent.rvkxse.com).
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");
const sha256 = (d) => crypto.createHash("sha256").update(d).digest();
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fail = (message, status) => Object.assign(new Error(message), { status: status || 400 });

// ---------- TOTP ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(buf) {
  let bits = 0, val = 0, out = "";
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  const clean = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(key, counter, digits = 6) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(b).digest(), o = h[h.length - 1] & 15;
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(n).padStart(digits, "0");
}
// Nouveau secret et lien otpauth:// (QR code à scanner par l'application).
function newTotp(email) {
  const secret = b32enc(crypto.randomBytes(20));
  return { secret, uri: "otpauth://totp/" + encodeURIComponent("Agents IA:" + email) + "?secret=" + secret + "&issuer=" + encodeURIComponent("Agents IA") + "&algorithm=SHA1&digits=6&period=30" };
}
// Code valable (pas de 30 s courant, ±1 pour l'horloge du téléphone), jamais deux fois le même pas. Renvoie le pas ou null.
function totpCheck(secret, code, lastStep, now = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000), key = b32dec(secret);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (lastStep && s <= lastStep) continue;
    if (same(hotp(key, s), c)) return s;
  }
  return null;
}

// ---------- codes de secours ----------
const normCode = (c) => String(c || "").toLowerCase().replace(/[^0-9a-f]/g, "");
function newRecovery() {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString("hex").replace(/^(.{5})/, "$1-"));
  return { codes, hashes: codes.map((c) => sha256(normCode(c)).toString("hex")) };
}
const recoveryIndex = (hashes, code) => (normCode(code).length === 10 ? (hashes || []).indexOf(sha256(normCode(code)).toString("hex")) : -1);

// ---------- CBOR (ce qu'utilise WebAuthn : entiers, octets, textes, tableaux, tables, simples) ----------
function cbor(buf) {
  let i = 0;
  const len = (info) => {
    if (info < 24) return info;
    if (info === 24) return buf[i++];
    if (info === 25) { const v = buf.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; }
    throw fail("Donnée de la clé illisible (longueur).");
  };
  const read = () => {
    const b = buf[i++], type = b >> 5, info = b & 31;
    switch (type) {
      case 0: return len(info);
      case 1: return -1 - len(info);
      case 2: { const n = len(info), v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
      case 3: { const n = len(info), v = buf.toString("utf8", i, i + n); i += n; return v; }
      case 4: { const n = len(info), a = []; for (let k = 0; k < n; k++) a.push(read()); return a; }
      case 5: { const n = len(info), m = new Map(); for (let k = 0; k < n; k++) { const key = read(); m.set(key, read()); } return m; }
      case 7: return info === 20 ? false : info === 21 ? true : null;
      default: throw fail("Donnée de la clé illisible (type " + type + ").");
    }
  };
  const value = read();
  return { value, end: i };
}

// ---------- WebAuthn ----------
const ORIGINS = (process.env.PANEL_ORIGINS || "https://agent.rvkxse.com").split(",").map((s) => s.trim()).filter(Boolean);
const rpId = () => new URL(ORIGINS[0]).hostname;

// Clé publique COSE -> clé Node (EC P-256, RSA, Ed25519).
function coseKey(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && m.get(-1) === 1) return { alg: alg || -7, jwk: { kty: "EC", crv: "P-256", x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 3) return { alg: alg || -257, jwk: { kty: "RSA", n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  if (kty === 1 && m.get(-1) === 6) return { alg: alg || -8, jwk: { kty: "OKP", crv: "Ed25519", x: b64u(m.get(-2)) } };
  throw fail("Type de clé non pris en charge.");
}
// Données de l'authentificateur : empreinte du domaine, drapeaux, compteur, et (à l'inscription) la clé créée.
function parseAuthData(ad) {
  if (ad.length < 37) throw fail("Réponse de la clé incomplète.");
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  if (out.flags & 64) { // données de la clé créée
    const idLen = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + idLen);
    out.cose = cbor(ad.subarray(55 + idLen)).value;
  }
  return out;
}
function checkClient(clientDataJSON, type, challenge) {
  let c;
  try { c = JSON.parse(unb64u(clientDataJSON).toString("utf8")); } catch (e) { throw fail("Réponse de la clé illisible."); }
  if (c.type !== type) throw fail("Réponse de la clé inattendue.");
  if (!challenge || !same(c.challenge, challenge)) throw fail("Défi expiré ou différent : recommence.");
  if (!ORIGINS.includes(c.origin)) throw fail("Origine refusée : " + c.origin);
}
function checkAuthData(a) {
  if (!same(a.rpIdHash.toString("hex"), sha256(rpId()).toString("hex"))) throw fail("Clé créée pour un autre site.");
  if (!(a.flags & 1)) throw fail("Présence non confirmée sur la clé (touche-la).");
}

// Inscription d'une clé : options pour navigator.credentials.create.
function registrationOptions(user, existing) {
  const challenge = b64u(crypto.randomBytes(32));
  return { challenge, publicKey: { challenge, rp: { name: "Agents IA", id: rpId() }, user: { id: b64u(Buffer.from(user.id)), name: user.email, displayName: user.name || user.email },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }], timeout: 120000, attestation: "none",
    authenticatorSelection: { userVerification: "preferred", residentKey: "discouraged" }, excludeCredentials: (existing || []).map((k) => ({ type: "public-key", id: k.id })) } };
}
// Réponse de la clé à l'inscription -> { id, jwk, alg, signCount }.
function verifyRegistration(cred, challenge) {
  const r = (cred && cred.response) || {};
  checkClient(r.clientDataJSON, "webauthn.create", challenge);
  const att = cbor(unb64u(r.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get("authData"))) throw fail("Réponse de la clé illisible.");
  const a = parseAuthData(att.get("authData"));
  checkAuthData(a);
  if (!a.credId || !(a.cose instanceof Map)) throw fail("La clé n'a pas donné de clé publique.");
  const k = coseKey(a.cose);
  crypto.createPublicKey({ key: k.jwk, format: "jwk" }); // clé publique valide
  return { id: b64u(a.credId), jwk: k.jwk, alg: k.alg, signCount: a.signCount };
}
// Connexion : options pour navigator.credentials.get.
function assertionOptions(keys) {
  const challenge = b64u(crypto.randomBytes(32));
  return { challenge, publicKey: { challenge, rpId: rpId(), timeout: 120000, userVerification: "preferred", allowCredentials: keys.map((k) => ({ type: "public-key", id: k.id })) } };
}
// Réponse de la clé à la connexion -> nouveau compteur de signatures (exception si refusée).
function verifyAssertion(cred, key, challenge) {
  const r = (cred && cred.response) || {};
  checkClient(r.clientDataJSON, "webauthn.get", challenge);
  const ad = unb64u(r.authenticatorData), a = parseAuthData(ad);
  checkAuthData(a);
  const data = Buffer.concat([ad, sha256(unb64u(r.clientDataJSON))]), sig = unb64u(r.signature);
  const pub = crypto.createPublicKey({ key: key.jwk, format: "jwk" });
  const ok = key.alg === -8 ? crypto.verify(null, data, pub, sig) : key.alg === -257 ? crypto.verify("sha256", data, pub, sig) : crypto.verify("sha256", data, { key: pub, dsaEncoding: "der" }, sig);
  if (!ok) throw fail("Signature de la clé invalide.", 401);
  if (a.signCount && key.signCount && a.signCount <= key.signCount) throw fail("Clé refusée : compteur de signatures en arrière (clé copiée ?).", 401);
  return a.signCount;
}

module.exports = { b32enc, b32dec, hotp, newTotp, totpCheck, newRecovery, recoveryIndex, cbor, registrationOptions, verifyRegistration, assertionOptions, verifyAssertion, rpId, ORIGINS };
