import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Parse .env file and return object, or null if no .env exists
 */
export function loadEnvFile(dir = process.cwd()) {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) {
    return null;
  }
  const content = readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  }
  return env;
}

/**
 * Write or update a single key=value line in a .env file.
 * Updates the line in place if the key exists; appends if not.
 *
 * @param {string} key
 * @param {string} value
 * @param {string} filePath - Absolute path to the .env file
 */
export function writeEnvKey(key, value, filePath) {
  let c = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  c = re.test(c) ? c.replace(re, line) : (c.trimEnd() + '\n' + line + '\n');
  writeFileSync(filePath, c);
}
