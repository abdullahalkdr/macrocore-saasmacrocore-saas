// bcryptjs, not bcrypt: pure JS, no native gyp build — one less thing that can
// fail to compile on a deploy target (Railway) or a locked-down sandbox.
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
