/** Remote-access policy edited on the Plugins page, stored beside the plugin's other data. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export interface RemoteSettings {
  allowedWorkspaceRoots: string[];
  allowedPermissionPresets: string[];
  allowedAgentPresets: string[];
}
export const SETTINGS_FIELDS = [
  'allowedWorkspaceRoots',
  'allowedPermissionPresets',
  'allowedAgentPresets',
] as const;
export const DEFAULT_SETTINGS: RemoteSettings = {
  allowedWorkspaceRoots: [],
  allowedPermissionPresets: ['workspace-write', 'read-only'],
  allowedAgentPresets: [],
};
const MAX_ITEMS = 64;

function list(value: unknown, field: string, check?: (item: string) => string | undefined) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS)
    return `${field} must be a list of at most ${MAX_ITEMS} entries`;
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 4096 || /[\x00-\x1f]/.test(item))
      return `${field} entries must be non-empty text`;
    const problem = check?.(item);
    if (problem) return problem;
  }
  if (new Set(value).size !== value.length) return `${field} entries must be unique`;
  return undefined;
}

/** Validates a partial update; only known fields are accepted. */
export function validateSettings(
  input: unknown,
): { value: Partial<RemoteSettings> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected an object' };
  const value: Partial<RemoteSettings> = {};
  for (const [field, entry] of Object.entries(input)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(field)) return { error: `Unknown field ${field}` };
    const problem = list(entry, field, (item) =>
      field === 'allowedWorkspaceRoots' && !isAbsolute(item)
        ? 'Workspace folders must be absolute paths'
        : undefined,
    );
    if (problem) return { error: problem };
    value[field as keyof RemoteSettings] = [...(entry as string[])];
  }
  return { value };
}

export function loadSettings(path: string, warn: (message: string) => void): RemoteSettings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const checked = validateSettings(JSON.parse(raw));
    if ('error' in checked) throw new Error(checked.error);
    return { ...DEFAULT_SETTINGS, ...checked.value };
  } catch (error) {
    warn(`dsh-remote: ignoring invalid ${path}: ${(error as Error).message}`);
    return { ...DEFAULT_SETTINGS };
  }
}

/** Atomic owner-only write, so a crash never leaves a half-written policy. */
export function saveSettings(path: string, settings: RemoteSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
