import crypto from "crypto";

/*
  Minimal RFC 6238 TOTP (30s step, 6 digits, SHA-1) + RFC 4648 base32.
  Self-contained so we don't add a dependency. Used for optional 2FA on the
  public URL. The secret is stored encrypted at rest (see secrets.ts).
*/

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateBase32Secret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = "";
  for (let i = 0; i < buf.length; i++) bits += buf[i].toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

/** Verify a 6-digit code against the secret, allowing ±1 time step of drift. */
export function verifyTotp(base32Secret: string, token: string): boolean {
  const clean = (token || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const secret = base32Decode(base32Secret);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) {
    if (hotp(secret, step + w) === clean) return true;
  }
  return false;
}

/** otpauth:// provisioning URI for QR codes / manual entry in authenticator apps. */
export function provisioningUri(base32Secret: string, account: string, issuer = "Concourse"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
