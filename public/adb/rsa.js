// ADB RSA authentication without dependencies.
//
// adbd sends a 20-byte token and expects it signed as if it were a SHA-1 digest
// (PKCS#1 v1.5 with the SHA-1 DigestInfo). WebCrypto can only sign messages it hashes
// itself, so the RSA private operation is done with BigInt (CRT, ~10 ms).

const SHA1_DIGEST_INFO = [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14];

const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToBig = (b) => (b.length ? BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`) : 0n);
const b64uToBig = (s) => bytesToBig(b64uToBytes(s));

function bigToBytes(n, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function modInverse(a, m) {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
  while (r1) {
    const qt = r0 / r1;
    [r0, r1] = [r1, r0 - qt * r1];
    [s0, s1] = [s1, s0 - qt * s1];
  }
  return ((s0 % m) + m) % m;
}

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** An RSA-2048 key usable for ADB auth, built from a private JWK (n, e, d, p, q, dp, dq, qi). */
export class AdbKey {
  constructor(jwk) {
    this.jwk = jwk;
    this.n = b64uToBig(jwk.n);
    this.p = b64uToBig(jwk.p);
    this.q = b64uToBig(jwk.q);
    this.dp = b64uToBig(jwk.dp);
    this.dq = b64uToBig(jwk.dq);
    this.qi = b64uToBig(jwk.qi);
    this.size = (this.n.toString(16).length + 1) >> 1;
  }

  static async generate() {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' },
      true,
      ['sign', 'verify'],
    );
    return new AdbKey(await crypto.subtle.exportKey('jwk', pair.privateKey));
  }

  /** Sign adbd's AUTH token. */
  sign(token) {
    const k = this.size;
    const em = new Uint8Array(k).fill(0xff);
    em[0] = 0;
    em[1] = 1;
    const tLen = SHA1_DIGEST_INFO.length + token.length;
    em[k - tLen - 1] = 0;
    em.set(SHA1_DIGEST_INFO, k - tLen);
    em.set(token, k - token.length);
    const m = bytesToBig(em);
    // CRT: s = m^d mod n
    const m1 = modPow(m, this.dp, this.p);
    const m2 = modPow(m, this.dq, this.q);
    const h = (this.qi * ((m1 - m2 + this.p) % this.p)) % this.p;
    return bigToBytes(m2 + h * this.q, k);
  }

  /** Public key in Android's RSAPublicKey format, base64-encoded (as in ~/.android/adbkey.pub). */
  androidPublicKey() {
    const words = this.size / 4;
    const dv = new DataView(new ArrayBuffer(4 + 4 + this.size * 2 + 4));
    const r32 = 1n << 32n;
    dv.setUint32(0, words, true);
    dv.setUint32(4, Number((r32 - modInverse(this.n % r32, r32)) % r32), true);
    const putWords = (x, off) => {
      for (let i = 0; i < words; i++) {
        dv.setUint32(off + i * 4, Number(x % r32), true);
        x >>= 32n;
      }
    };
    putWords(this.n, 8);
    putWords((1n << BigInt(this.size * 16)) % this.n, 8 + this.size);
    dv.setUint32(8 + this.size * 2, Number(b64uToBig(this.jwk.e)), true);
    return toBase64(new Uint8Array(dv.buffer));
  }
}

const STORE_KEY = 'droidpanel.adbkey';

/** The browser's ADB key, created on first use and kept in localStorage. */
export async function browserKey() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) return new AdbKey(JSON.parse(saved));
  } catch { /* storage blocked or corrupted: make a new key */ }
  const key = await AdbKey.generate();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(key.jwk)); } catch { /* the phone will ask again next time */ }
  return key;
}
