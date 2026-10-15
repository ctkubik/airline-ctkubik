// Encrypts Southwest account passwords before they're stored. Same format and
// key as worker/lib/credentials.py: "enc:v1:" + base64(nonce + ciphertext +
// tag), AES-256-GCM, key from CREDENTIALS_KEY (the macOS Keychain, passed in by
// macos/run.sh) or DATA_DIR/.credentials-key.
import crypto from "crypto";
import fs from "fs";
import path from "path";

const PREFIX = "enc:v1:";

function loadKey(): Buffer | null {
  const env = (process.env.CREDENTIALS_KEY || "").trim();
  const hex =
    env ||
    (() => {
      const dataDir = process.env.DATA_DIR || path.resolve("/app", "data");
      try {
        return fs.readFileSync(path.join(dataDir, ".credentials-key"), "utf8").trim();
      } catch {
        return "";
      }
    })();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

// Returns the encrypted value, or the plain value when no key exists yet (the
// worker encrypts it within a minute and creates the key if needed).
export function encryptPassword(plain: string): string {
  const key = loadKey();
  if (!key) return plain;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return PREFIX + Buffer.concat([nonce, sealed]).toString("base64");
}

// Reverse of encryptPassword. Plain values (saved before a key existed) pass
// through; a value that can't be decrypted returns null.
export function decryptPassword(value: string): string | null {
  if (!value.startsWith(PREFIX)) return value;
  const key = loadKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
