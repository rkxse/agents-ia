// Icône du panel installé comme une app (manifeste, notifications push) : le logo du favicon (trois nœuds reliés sur un
// carré arrondi dégradé indigo -> cyan), dessiné ici en PNG sans dépendance (anticrénelage par sur-échantillonnage 4×4).
const zlib = require("zlib");

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// Distance d'un point au segment [a, b].
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
// Coordonnées dans un carré de 64 (comme le favicon) ; maskable : logo réduit pour la zone sûre d'Android.
function shade(x, y, maskable) {
  const r = maskable ? 0 : 14, inside = (() => { const cx = Math.max(r, Math.min(64 - r, x)), cy = Math.max(r, Math.min(64 - r, y)); return Math.hypot(x - cx, y - cy) <= r; })();
  if (!inside) return null;
  const t = (x + y) / 128, bg = [79 + (6 - 79) * t, 70 + (182 - 70) * t, 229 + (212 - 229) * t];
  const s = maskable ? 0.72 : 1, X = 32 + (x - 32) / s, Y = 32 + (y - 32) / s;
  const white = Math.hypot(X - 22, Y - 32) <= 6 || Math.hypot(X - 42, Y - 20) <= 5 || Math.hypot(X - 42, Y - 44) <= 5 ||
    segDist(X, Y, 22, 32, 42, 20) <= 1.5 || segDist(X, Y, 22, 32, 42, 44) <= 1.5;
  return white ? [255, 255, 255] : bg;
}
const cache = new Map();
function png(size, maskable) {
  const key = size + (maskable ? "m" : "");
  if (cache.has(key)) return cache.get(key);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const c = shade(((x + (sx + 0.5) / 4) / size) * 64, ((y + (sy + 0.5) / 4) / size) * 64, maskable);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      rows[o] = a ? r / a : 0; rows[o + 1] = a ? g / a : 0; rows[o + 2] = a ? b / a : 0; rows[o + 3] = (a / 16) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const out = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  cache.set(key, out);
  return out;
}

module.exports = { png };
