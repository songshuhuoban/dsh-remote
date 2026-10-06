/// Paths on the DSH host. The host may run Windows, macOS or Linux while this
/// phone runs Android or iOS, so a host path is never parsed with the phone's
/// own path rules. Hosts report paths in their native canonical form; the app
/// only displays them, splits them into breadcrumbs, or converts a pasted path
/// into the host's style, all through these helpers. The DSH plugin still
/// resolves every path on the host and decides what may be used.
///
/// A port of `packages/protocol/src/host-path.ts`; keep the two in step.
library;

enum HostPathStyle { posix, windows }

/// The style a host reports in `workspace.list` (`'windows'` or `'posix'`).
HostPathStyle? parseHostPathStyle(Object? value) => switch (value) {
  'windows' => HostPathStyle.windows,
  'posix' => HostPathStyle.posix,
  _ => null,
};

/// The style shared by [paths] a host returned, for hosts that do not report
/// one; null when they are absent or disagree.
HostPathStyle? inferHostPathStyle(Iterable<String> paths) {
  final styles = paths.map(hostPathStyle).nonNulls.toSet();
  return styles.length == 1 ? styles.single : null;
}

final _control = RegExp(r'[\x00-\x1f\x7f]');
final _driveAbsolute = RegExp(r'^[A-Za-z]:[\\/]');
final _uncAbsolute = RegExp(r'^[\\/]{2}[^\\/]+[\\/]+[^\\/]+');

/// Characters Windows forbids in a path segment (the drive colon is checked
/// separately).
final _windowsSegmentForbidden = RegExp(r'[<>:"|?*]');
const _maxPath = 4096;

/// The style of an absolute host path, or null for a relative or malformed
/// one.
HostPathStyle? hostPathStyle(String path) {
  if (_driveAbsolute.hasMatch(path) || _uncAbsolute.hasMatch(path)) {
    return HostPathStyle.windows;
  }
  if (path.startsWith('/')) return HostPathStyle.posix;
  return null;
}

({String root, List<String> segments})? _windowsParts(String path) {
  List<String> split(String? rest) =>
      rest == null || rest.isEmpty ? <String>[] : rest.split(r'\');
  final drive = RegExp(r'^([A-Za-z]):\\(.*)$', dotAll: true).firstMatch(path);
  if (drive != null) {
    return (root: '${drive[1]}:\\', segments: split(drive[2]));
  }
  final unc = RegExp(
    r'^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$',
    dotAll: true,
  ).firstMatch(path);
  if (unc != null) {
    return (root: '\\\\${unc[1]}\\${unc[2]}', segments: split(unc[3]));
  }
  return null;
}

/// True for an absolute path in one host style's canonical form: a single
/// separator style, no empty, `.` or `..` segments, no trailing separator, no
/// control characters. A filesystem root (`/`, `C:\`, `\\server\share`)
/// counts only with [allowRoot].
bool isCanonicalHostPath(String path, {bool allowRoot = false}) {
  if (path.isEmpty || path.length > _maxPath || _control.hasMatch(path)) {
    return false;
  }
  switch (hostPathStyle(path)) {
    case HostPathStyle.posix:
      if (path == '/') return allowRoot;
      if (path.contains(r'\') || path.endsWith('/')) return false;
      return path
          .substring(1)
          .split('/')
          .every((part) => part.isNotEmpty && part != '.' && part != '..');
    case HostPathStyle.windows:
      if (path.contains('/')) return false;
      final parts = _windowsParts(path);
      if (parts == null) return false;
      if (RegExp(r'[<>"|?*:]').hasMatch(parts.root.substring(2))) return false;
      if (parts.segments.isEmpty) return allowRoot;
      return parts.segments.every(
        (part) =>
            part.isNotEmpty &&
            part != '.' &&
            part != '..' &&
            !_windowsSegmentForbidden.hasMatch(part) &&
            !RegExp(r'[ .]$').hasMatch(part),
      );
    case null:
      return false;
  }
}

/// Resolves `.` and `..` lexically; `..` never climbs above the root.
List<String> _resolveSegments(Iterable<String> segments) {
  final out = <String>[];
  for (final part in segments) {
    if (part.isEmpty || part == '.') continue;
    if (part == '..') {
      if (out.isNotEmpty) out.removeLast();
    } else {
      out.add(part);
    }
  }
  return out;
}

/// The path of a `file:` URL as a URL parser in a browser reads it, or null
/// when it is malformed.
String? _fileUrlPath(String value) {
  // As in browsers, backslashes separate too and `file://C:/x` names a drive.
  final normalized = value
      .replaceAll(r'\', '/')
      .replaceFirstMapped(
        RegExp(r'^file:/*(?=[A-Za-z][:|](?:/|$))', caseSensitive: false),
        (_) => 'file:///',
      );
  try {
    final url = Uri.parse(normalized);
    var path = Uri.decodeComponent(url.path);
    if (url.host.isNotEmpty && url.host != 'localhost') {
      path = '//${url.host}$path';
    }
    // file:///C:/x has the path /C:/x (or /C|/x).
    final drive = RegExp(r'^/([A-Za-z])[:|](?=/|$)').firstMatch(path);
    if (drive != null) path = '${drive[1]}:${path.substring(3)}';
    return path;
  } catch (_) {
    // A malformed URL or percent-encoding.
    return null;
  }
}

/// Converts a path a person pasted (from either OS, quoted, as a `file:` URL,
/// with mixed or doubled separators) into the host's canonical style. `~`
/// stays for the host to expand. Returns null when the input cannot be an
/// absolute path on that host.
String? toHostPath(String input, HostPathStyle style) {
  var path = input
      .trim()
      .replaceFirstMapped(
        RegExp(r'''^(['"])(.*)\1$''', dotAll: true),
        (match) => match[2]!,
      )
      .trim();
  if (path.isEmpty || path.length > _maxPath || _control.hasMatch(path)) {
    return null;
  }
  if (RegExp(r'^file://', caseSensitive: false).hasMatch(path)) {
    final fromUrl = _fileUrlPath(path);
    if (fromUrl == null) return null;
    path = fromUrl;
  }
  final home = RegExp(r'^~(?=$|[\\/])').hasMatch(path);
  if (style == HostPathStyle.windows) {
    path = path.replaceAll('/', r'\');
    if (home) {
      return [
        '~',
        ..._resolveSegments(path.substring(1).split(r'\')),
      ].join(r'\');
    }
    final drive = RegExp(
      r'^([A-Za-z]):(?:\\(.*))?$',
      dotAll: true,
    ).firstMatch(path);
    if (drive != null) {
      final segments = _resolveSegments((drive[2] ?? '').split(r'\'));
      return '${drive[1]!.toUpperCase()}:\\${segments.join(r'\')}';
    }
    final unc = RegExp(
      r'^\\\\+([^\\]+)\\+([^\\]+)(.*)$',
      dotAll: true,
    ).firstMatch(path);
    if (unc != null) {
      final segments = _resolveSegments(unc[3]!.split(r'\'));
      return ['\\\\${unc[1]}\\${unc[2]}', ...segments].join(r'\');
    }
    return null;
  }
  // A Windows path cannot name anything on a POSIX host.
  if (_driveAbsolute.hasMatch(path) || path.startsWith(r'\\')) {
    return null;
  }
  if (home) {
    return ['~', ..._resolveSegments(path.substring(1).split('/'))].join('/');
  }
  if (!path.startsWith('/')) return null;
  return '/${_resolveSegments(path.split('/')).join('/')}';
}

/// One breadcrumb: a folder's display name and its full host path.
typedef HostPathCrumb = ({String name, String path});

/// Breadcrumbs for a canonical host path: the root first, then each folder.
List<HostPathCrumb> hostPathCrumbs(String path) {
  switch (hostPathStyle(path)) {
    case HostPathStyle.posix:
      final crumbs = <HostPathCrumb>[(name: '/', path: '/')];
      var at = '';
      for (final part in path.split('/').where((part) => part.isNotEmpty)) {
        at += '/$part';
        crumbs.add((name: part, path: at));
      }
      return crumbs;
    case HostPathStyle.windows:
      final trimmed = path.replaceFirst(RegExp(r'\\+$'), '');
      final parts = _windowsParts(
        RegExp(r'^[A-Za-z]:$').hasMatch(trimmed) ? '$trimmed\\' : trimmed,
      );
      if (parts == null) return [(name: path, path: path)];
      final top = parts.root.replaceFirst(RegExp(r'\\$'), '');
      final crumbs = <HostPathCrumb>[(name: top, path: parts.root)];
      var at = top;
      for (final part in parts.segments.where((part) => part.isNotEmpty)) {
        at += '\\$part';
        crumbs.add((name: part, path: at));
      }
      return crumbs;
    case null:
      return [(name: path, path: path)];
  }
}

/// The last folder name of a host path, in that path's own style.
String hostPathName(String path) =>
    hostPathCrumbs(path).lastOrNull?.name ?? path;

/// Whether [path] is [folder] or inside it, compared as host paths.
bool hostPathWithin(String path, String folder) =>
    hostPathCrumbs(path).any((crumb) => crumb.path == folder);
