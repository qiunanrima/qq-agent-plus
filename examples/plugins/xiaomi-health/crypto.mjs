// Adapted from ahwhshen/xiaomi-health-plugin (MIT, copyright 2026 抽卡保底真君).
// See LICENSE and README.md for provenance. Network and account handling are owned by this plugin.
import { createHash, randomBytes } from 'node:crypto';
const base64 = value => Buffer.from(value).toString('base64');
const bytes = value => Buffer.from(value, 'base64');
class XiaomiError extends Error {}
function rc4(key, input, skip = 1024) {
  if (!key.length) throw new XiaomiError("RC4 key is empty");
  const s = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 255;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
  }
  let i = 0;
  j = 0;
  const next = () => {
    i = (i + 1) & 255;
    j = (j + (s[i] ?? 0)) & 255;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
    return s[((s[i] ?? 0) + (s[j] ?? 0)) & 255] ?? 0;
  };
  for (let n = 0; n < skip; n += 1) next();
  return Uint8Array.from(input, (value) => value ^ next());
}
function signedNonce(ssecurity, nonce) {
  const hash = createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest();
  return base64(hash);
}
function sha1Base64(value) {
  return createHash("sha1").update(value, "utf8").digest("base64");
}
function signatureMessage(method, path, params, nonce) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return [
    method.toUpperCase(),
    normalized,
    ...Object.keys(params).sort().map((key) => `${key}=${params[key]}`),
    nonce,
  ].join("&");
}
function encryptedParams(method, path, ssecurity, params) {
  const nonce = base64(
    Buffer.concat([
      randomBytes(8),
      (() => {
        const result = Buffer.alloc(4);
        result.writeUInt32BE(Math.floor(Date.now() / 60_000), 0);
        return result;
      })(),
    ]),
  );
  const snonce = signedNonce(ssecurity, nonce);
  const raw = {};
  if (params) raw.data = JSON.stringify(params);
  const rc4Hash = sha1Base64(signatureMessage(method, path, raw, snonce));
  raw.rc4_hash__ = rc4Hash;
  const entries = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
  const plaintext = Buffer.concat(entries.map(([, value]) => Buffer.from(value, "utf8")));
  const encrypted = rc4(bytes(snonce), plaintext);
  const output = {};
  let position = 0;
  for (const [key, value] of entries) {
    const length = Buffer.byteLength(value, "utf8");
    output[key] = base64(encrypted.slice(position, position + length));
    position += length;
  }
  output.signature = sha1Base64(signatureMessage(method, path, output, snonce));
  output._nonce = nonce;
  return output;
}
function decryptResponse(ssecurity, nonce, ciphertext) {
  const snonce = signedNonce(ssecurity, nonce);
  const plaintext = Buffer.from(rc4(bytes(snonce), bytes(ciphertext))).toString("utf8");
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}


export { rc4, signedNonce, encryptedParams, decryptResponse, sha1Base64 };

