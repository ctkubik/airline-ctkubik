import crypto from "crypto";

/**
 * At-rest encryption for stored Southwest account passwords.
 *
 * The worker must recover the plaintext to log in to Southwest, so a one-way
 * hash is impossible — instead values are encrypted with AES-256-GCM using a
 * key derived from AUTH_SECRET. A copied database file (a backup, a stolen
 * volume snapshot) then no longer exposes airline credentials on its own.
 *
 * Format (must stay in sync with worker/lib/secrets.py):
 *   enc:v1:base64(iv[12] || tag[16] || ciphertext)
 *
 * Note: changing AUTH_SECRET makes existing values undecryptable — Southwest
 * account passwords must be re-entered after rotating it.
 */

const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext; // no secret configured (dev) — store as-is
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext
  const key = getKey();
  if (!key) throw new Error("AUTH_SECRET is not set; cannot decrypt stored credential");
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
