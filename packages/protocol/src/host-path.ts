/**
 * Paths on the DSH host. The host may run Windows, macOS or Linux while the controlling device
 * runs something else, so a host path is never parsed with the controller's own path rules.
 * Hosts report paths in their native canonical form; controllers only display them, split them
 * into breadcrumbs, or convert a pasted path into the host's style, all through these helpers.
 * The DSH plugin still resolves every path on the host and decides what may be used.
 */
export type HostPathStyle = 'posix' | 'windows';

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters Windows forbids in a path segment (the drive colon is checked separately). */
const WINDOWS_SEGMENT_FORBIDDEN = /[<>:"|?*]/;
const MAX_PATH = 4096;

/** The style of an absolute host path, or null for a relative or malformed one. */
export function hostPathStyle(path: string): HostPathStyle | null {
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path)) return 'windows';
  if (path.startsWith('/')) return 'posix';
  return null;
}

function windowsParts(path: string): { root: string; segments: string[] } | null {
  const drive = /^([A-Za-z]):\\(.*)$/s.exec(path);
  if (drive) return { root: `${drive[1]}:\\`, segments: drive[2] ? drive[2].split('\\') : [] };
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/s.exec(path);
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}`, segments: unc[3] ? unc[3].split('\\') : [] };
  return null;
}

/**
 * True for an absolute path in one host style's canonical form: a single separator style,
 * no empty, `.` or `..` segments, no trailing separator, no control characters. A filesystem
 * root (`/`, `C:\`, `\\server\share`) counts only with `allowRoot`.
 */
export function isCanonicalHostPath(path: string, { allowRoot = false } = {}): boolean {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH || CONTROL.test(path))
    return false;
  const style = hostPathStyle(path);
  if (style === 'posix') {
    if (path === '/') return allowRoot;
    if (path.includes('\\') || path.endsWith('/')) return false;
    return path
      .slice(1)
      .split('/')
      .every((part) => part && part !== '.' && part !== '..');
  }
  if (style === 'windows') {
    if (path.includes('/')) return false;
    const parts = windowsParts(path);
    if (!parts) return false;
    if (/[<>"|?*:]/.test(parts.root.slice(2))) return false;
    if (!parts.segments.length) return allowRoot;
    return parts.segments.every(
      (part) =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !WINDOWS_SEGMENT_FORBIDDEN.test(part) &&
        !/[ .]$/.test(part),
    );
  }
  return false;
}

/** Resolves `.` and `..` lexically; `..` never climbs above the root. */
function resolveSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const part of segments) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

/**
 * Converts a path a person pasted (from either OS, quoted, as a `file:` URL, with mixed or
 * doubled separators) into the host's canonical style. `~` stays for the host to expand.
 * Returns null when the input cannot be an absolute path on that host.
 */
export function toHostPath(input: string, style: HostPathStyle): string | null {
  let path = input.trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
  if (!path || path.length > MAX_PATH || CONTROL.test(path)) return null;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      if (url.host && url.host !== 'localhost') path = `//${url.host}${path}`;
      // file:///C:/x has the pathname /C:/x.
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  const home = /^~(?=$|[\\/])/.test(path);
  if (style === 'windows') {
    path = path.replace(/\//g, '\\');
    if (home) return ['~', ...resolveSegments(path.slice(1).split('\\'))].join('\\');
    const drive = /^([A-Za-z]):(?:\\(.*))?$/s.exec(path);
    if (drive) {
      const segments = resolveSegments((drive[2] ?? '').split('\\'));
      return `${drive[1].toUpperCase()}:\\${segments.join('\\')}`;
    }
    const unc = /^\\\\+([^\\]+)\\+([^\\]+)(.*)$/s.exec(path);
    if (unc) {
      const segments = resolveSegments(unc[3].split('\\'));
      return [`\\\\${unc[1]}\\${unc[2]}`, ...segments].join('\\');
    }
    return null;
  }
  // A Windows path cannot name anything on a POSIX host.
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return null;
  if (home) return ['~', ...resolveSegments(path.slice(1).split('/'))].join('/');
  if (!path.startsWith('/')) return null;
  return `/${resolveSegments(path.split('/')).join('/')}`;
}

/** Breadcrumbs for a canonical host path: the root first, then each folder. */
export function hostPathCrumbs(path: string): { name: string; path: string }[] {
  const style = hostPathStyle(path);
  if (style === 'posix') {
    const crumbs = [{ name: '/', path: '/' }];
    let at = '';
    for (const part of path.split('/').filter(Boolean)) {
      at += `/${part}`;
      crumbs.push({ name: part, path: at });
    }
    return crumbs;
  }
  if (style === 'windows') {
    const trimmed = path.replace(/\\+$/, '');
    const parts = windowsParts(/^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed);
    if (!parts) return [{ name: path, path }];
    const crumbs = [{ name: parts.root.replace(/\\$/, ''), path: parts.root }];
    let at = parts.root.replace(/\\$/, '');
    for (const part of parts.segments.filter(Boolean)) {
      at += `\\${part}`;
      crumbs.push({ name: part, path: at });
    }
    return crumbs;
  }
  return [{ name: path, path }];
}

/** The last folder name of a host path, in that path's own style. */
export function hostPathName(path: string): string {
  return hostPathCrumbs(path).at(-1)?.name ?? path;
}
