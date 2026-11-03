// Double authentification (lib/mfa.js, lib/auth.js) : codes TOTP (valeurs de la RFC), codes de secours, et clé de
// sécurité WebAuthn simulée (paire de clés créée ici, réponses construites comme celles d'une vraie clé). Comptes dans
// un dossier jetable. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AGENTS_AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gp-mfa-"));
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mfa = require("../lib/mfa");
const auth = require("../lib/auth");
test.after(() => fs.rmSync(process.env.AGENTS_AUTH_DIR, { recursive: true, force: true }));

const ORIGIN = mfa.ORIGINS[0], RP = mfa.rpId();
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (d) => crypto.createHash("sha256").update(d).digest();
// Encodeur CBOR minimal (ce que produit une clé).
function cbor(v) {
  const head = (t, n) => (n < 24 ? Buffer.from([(t << 5) | n]) : n < 256 ? Buffer.from([(t << 5) | 24, n]) : Buffer.from([(t << 5) | 25, n >> 8, n & 255]));
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("type");
}
// Clé de sécurité simulée : P-256, compteur de signatures.
function fakeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }), credId = crypto.randomBytes(32);
  let count = 0;
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const client = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin: origin || ORIGIN }));
  return {
    create(challenge, opts = {}) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(opts.rp || RP), Buffer.from([0x41]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      return { id: b64u(credId), response: { clientDataJSON: b64u(client("webauthn.create", challenge, opts.origin)), attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))) } };
    },
    get(challenge, opts = {}) {
      const c = Buffer.alloc(4); c.writeUInt32BE(opts.count !== undefined ? opts.count : ++count);
      const authData = Buffer.concat([sha(RP), Buffer.from([0x01]), c]), cd = client("webauthn.get", challenge, opts.origin);
      const sig = crypto.sign("sha256", Buffer.concat([authData, sha(cd)]), { key: privateKey, dsaEncoding: "der" });
      return { id: b64u(credId), response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}

test("TOTP : valeurs de la RFC, horloge ±30 s, jamais deux fois le même code", () => {
  const key = Buffer.from("12345678901234567890");
  assert.deepEqual([1, 2, 3, 9].map((c) => mfa.hotp(key, c)), ["287082", "359152", "969429", "520489"]); // RFC 4226
  assert.deepEqual(mfa.b32dec(mfa.b32enc(key)), key);
  const { secret, uri } = mfa.newTotp("lea@exemple.fr");
  assert.match(uri, /^otpauth:\/\/totp\/Agents%20IA%3Alea%40exemple\.fr\?secret=[A-Z2-7]{32}&issuer=Agents%20IA/);
  const t = 1_800_000_000_000, step = Math.floor(t / 30000), code = mfa.hotp(mfa.b32dec(secret), step);
  assert.equal(mfa.totpCheck(secret, code, 0, t), step);
  assert.equal(mfa.totpCheck(secret, code, 0, t + 30000), step, "téléphone 30 s en retard");
  assert.equal(mfa.totpCheck(secret, code, step, t), null, "code déjà utilisé");
  assert.equal(mfa.totpCheck(secret, code, 0, t + 120000), null, "trop vieux");
  assert.equal(mfa.totpCheck(secret, "12345", 0, t), null);
});

test("clé de sécurité : inscription puis connexion ; autre site, autre défi, clé copiée refusés", () => {
  const k = fakeKey();
  const reg = mfa.registrationOptions({ id: "u-1", email: "a@b.fr" }, []);
  assert.equal(reg.publicKey.rp.id, RP);
  const saved = mfa.verifyRegistration(k.create(reg.challenge), reg.challenge);
  assert.equal(saved.alg, -7);
  assert.throws(() => mfa.verifyRegistration(k.create(reg.challenge, { origin: "https://faux-site.fr" }), reg.challenge), /Origine refusée/);
  assert.throws(() => mfa.verifyRegistration(k.create(reg.challenge, { rp: "faux-site.fr" }), reg.challenge), /autre site/);
  assert.throws(() => mfa.verifyRegistration(k.create("autre-defi"), reg.challenge), /Défi/);
  const ch = mfa.assertionOptions([saved]).challenge;
  saved.signCount = mfa.verifyAssertion(k.get(ch), saved, ch);
  assert.equal(saved.signCount, 1);
  assert.throws(() => mfa.verifyAssertion(k.get(ch, { count: 1 }), saved, ch), /compteur/, "clé copiée (compteur en arrière)");
  const other = fakeKey().get(ch);
  other.id = saved.id;
  assert.throws(() => mfa.verifyAssertion(other, saved, ch), /Signature/, "signée par une autre clé");
});

test("connexion en deux étapes : mot de passe, puis code de secours ou clé ; essais limités", async () => {
  const s = await auth.signup({ email: "lea@exemple.fr", password: "secret123" }, "1.1.1.1", "t");
  const u = s.user;
  assert.equal((await auth.login({ email: "lea@exemple.fr", password: "secret123" }, "1.1.1.1", "t")).token.length > 20, true, "sans MFA : session directe");
  // Application d'authentification : mot de passe redemandé (une session volée ne suffit pas pour poser un facteur).
  await assert.rejects(() => auth.totpSetup(u, { password: "faux" }), (e) => e.status === 403);
  const t = await auth.totpSetup(u, { password: "secret123" }), code = mfa.hotp(mfa.b32dec(t.secret), Math.floor(Date.now() / 30000));
  assert.throws(() => auth.totpEnable(u, { code: "000000" }), /incorrect/);
  const en = auth.totpEnable(u, { code });
  assert.equal(en.recovery.length, 10, "codes de secours montrés une fois");
  // Clé de sécurité en plus.
  await assert.rejects(() => auth.keyOptions(u, {}), (e) => e.status === 403);
  const k = fakeKey(), o = await auth.keyOptions(u, { password: "secret123" });
  auth.keyAdd(u, { name: "YubiKey", credential: k.create(o.publicKey.challenge) });
  assert.deepEqual(auth.security(u).keys.map((x) => x.name), ["YubiKey"]);
  // Connexion : plus de session au mot de passe seul.
  const step1 = await auth.login({ email: "lea@exemple.fr", password: "secret123" }, "1.1.1.2", "t");
  assert.ok(step1.mfa && step1.mfa.ticket && step1.mfa.totp && step1.mfa.keys);
  assert.equal(step1.token, undefined);
  assert.throws(() => auth.loginSecondFactor({ ticket: step1.mfa.ticket, code: "123456" }, "1.1.1.2", "t"), /incorrect/);
  const ok = auth.loginSecondFactor({ ticket: step1.mfa.ticket, recovery: en.recovery[0] }, "1.1.1.2", "t");
  assert.ok(ok.token);
  assert.equal(auth.security(u).recoveryLeft, 9, "code de secours à usage unique");
  assert.throws(() => auth.loginSecondFactor({ ticket: step1.mfa.ticket, recovery: en.recovery[1] }, "1.1.1.2", "t"), /expirée/, "ticket déjà utilisé");
  // Avec la clé.
  const step2 = await auth.login({ email: "lea@exemple.fr", password: "secret123" }, "1.1.1.3", "t");
  const ko = auth.loginKeyOptions({ ticket: step2.mfa.ticket });
  assert.ok(auth.loginSecondFactor({ ticket: step2.mfa.ticket, credential: k.get(ko.publicKey.challenge) }, "1.1.1.3", "t").token);
  // 5 essais au plus par ticket.
  const step3 = await auth.login({ email: "lea@exemple.fr", password: "secret123" }, "1.1.1.4", "t");
  for (let i = 0; i < 5; i++) assert.throws(() => auth.loginSecondFactor({ ticket: step3.mfa.ticket, code: "00000" + i }, "1.1.1.4", "t"));
  assert.throws(() => auth.loginSecondFactor({ ticket: step3.mfa.ticket, recovery: en.recovery[2] }, "1.1.1.4", "t"), /Trop d'essais/);
  // Retirer : mot de passe demandé.
  await assert.rejects(() => auth.totpDisable(u, { password: "faux" }), /incorrect/);
  await auth.totpDisable(u, { password: "secret123" });
  await auth.keyRemove(u, auth.security(u).keys[0].id, { password: "secret123" });
  assert.equal(auth.security(u).recoveryLeft, 0, "plus de 2e facteur : plus de codes de secours");
  assert.ok((await auth.login({ email: "lea@exemple.fr", password: "secret123" }, "1.1.1.5", "t")).token);
});
