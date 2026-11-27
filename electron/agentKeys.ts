// macOS Keychain stores the API keys. The renderer receives only their presence.
import { execFile } from 'node:child_process';
import type { Provider } from '../shared/chat.ts';

const SERVICE = 'Agent Canvas API';
export const keyLookup = (provider: Provider) => ({
  command: '/usr/bin/security',
  args: ['find-generic-password', '-s', SERVICE, '-a', provider, '-w'],
});

function security(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', args, { timeout: 30_000 }, (err, stdout) => {
      if (err) reject(Object.assign(new Error('Could not access the API key in macOS Keychain.'), { code: err.code }));
      else resolve(stdout.trim());
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function hasAgentKey(provider: Provider): Promise<boolean> {
  try {
    await security(keyLookup(provider).args.slice(0, -1));
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 44) return false; // errSecItemNotFound
    throw err;
  }
}

export const readAgentKey = (provider: Provider): Promise<string> => security(keyLookup(provider).args);

export async function saveAgentKey(provider: Provider, key: string): Promise<void> {
  // The interactive command reads from stdin. Hex keeps the secret out of argv and prevents
  // quotes, newlines or other input from becoming security commands.
  await security(['-i'], `add-generic-password -U -s "${SERVICE}" -a ${provider} -X ${Buffer.from(key).toString('hex')}\n`);
}
