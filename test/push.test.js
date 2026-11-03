// Notifications push (lib/push.js) : contenu chiffré lisible par le téléphone (déchiffré ici comme le ferait le
// navigateur, RFC 8291), jeton VAPID valide (RFC 8292), seuls les services push connus acceptés. Lancer : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const push = require("../lib/push");

const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

test("contenu chiffré aes128gcm : le téléphone le déchiffre", () => {
  // Le « téléphone » : sa clé (p256dh) et son secret (auth).
  const ua = crypto.createECDH("prime256v1"), uaPub = ua.generateKeys(), auth = crypto.randomBytes(16);
  const body = push.encrypt({ p256dh: b64u(uaPub), auth: b64u(auth) }, '{"title":"Test","body":"Bonjour"}');
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const shared = ua.computeSecret(asPub);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "délimiteur du dernier enregistrement");
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), { title: "Test", body: "Bonjour" });
});

test("jeton VAPID : signé ES256, pour l'origine du service push", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const keys = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) };
  const h = push.vapidHeader("https://fcm.googleapis.com/fcm/send/abc", keys);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, keys.publicKey);
  const [head, body, sig] = t.split(".");
  assert.equal(JSON.parse(unb64u(body)).aud, "https://fcm.googleapis.com");
  assert.ok(crypto.verify("sha256", Buffer.from(head + "." + body), { key: publicKey, dsaEncoding: "ieee-p1363" }, unb64u(sig)));
});

test("abonnement : seuls les services push connus", () => {
  const keys = { p256dh: b64u(crypto.createECDH("prime256v1").generateKeys()), auth: b64u(crypto.randomBytes(16)) };
  assert.equal(push.validSub({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys }), true);
  assert.equal(push.validSub({ endpoint: "https://web.push.apple.com/abc", keys }), true);
  assert.equal(push.validSub({ endpoint: "https://evil.example.com/push", keys }), false);
  assert.equal(push.validSub({ endpoint: "http://fcm.googleapis.com/x", keys }), false);
});
