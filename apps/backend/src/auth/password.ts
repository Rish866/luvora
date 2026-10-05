import bcrypt from "bcryptjs";
import { config } from "../config";

/** Hash a plaintext password with bcrypt. Plaintext is never stored. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.bcryptRounds);
}

/** Constant-time-ish verification via bcrypt. */
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
