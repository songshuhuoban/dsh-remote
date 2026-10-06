// Mirrors tests/host-path.test.ts case for case: the phone and the DSH host
// may run different operating systems.
import 'package:dsh_remote_mobile/src/host_path.dart';
import 'package:flutter_test/flutter_test.dart';

const posix = HostPathStyle.posix;
const windows = HostPathStyle.windows;

void main() {
  group('host path styles', () {
    test('recognises POSIX, Windows drive and UNC paths, nothing relative', () {
      expect(hostPathStyle('/home/me/repo'), posix);
      expect(hostPathStyle(r'E:\work\repo'), windows);
      expect(hostPathStyle('e:/work/repo'), windows);
      expect(hostPathStyle(r'\\nas\share\repo'), windows);
      expect(hostPathStyle('work/repo'), isNull);
      expect(hostPathStyle('C:repo'), isNull);
    });

    test('accepts only canonical absolute paths in one style', () {
      for (final ok in [
        '/home/me/repo',
        r'E:\work\repo',
        r'c:\Users\me',
        r'\\nas\share\repo',
      ]) {
        expect(isCanonicalHostPath(ok), isTrue, reason: ok);
      }
      for (final bad in [
        '/',
        '/home/me/',
        '/home//me',
        '/home/./me',
        '/home/../etc',
        r'/home\me',
        r'E:\',
        r'E:\work\',
        'E:/work/repo',
        r'E:\work\..\x',
        r'E:\work\a<b',
        r'E:\work\trailing.',
        r'relative\path',
        '/bad\u0000byte',
      ]) {
        expect(isCanonicalHostPath(bad), isFalse, reason: bad);
      }
      expect(isCanonicalHostPath('/', allowRoot: true), isTrue);
      expect(isCanonicalHostPath(r'E:\', allowRoot: true), isTrue);
      expect(isCanonicalHostPath(r'\\nas\share', allowRoot: true), isTrue);
    });
  });

  group('converting pasted paths to the host style', () {
    test(
      'Windows hosts take forward slashes, quotes, file URLs and lower-case drives',
      () {
        expect(toHostPath('e:/work/repo/', windows), r'E:\work\repo');
        expect(toHostPath(r'"E:\work\\repo"', windows), r'E:\work\repo');
        expect(
          toHostPath('file:///C:/Users/me/My%20Docs', windows),
          r'C:\Users\me\My Docs',
        );
        expect(toHostPath('//nas/share/repo', windows), r'\\nas\share\repo');
        expect(toHostPath(r'C:\work\..\other\.\x', windows), r'C:\other\x');
        expect(toHostPath('C:', windows), r'C:\');
        expect(toHostPath('~/projects', windows), r'~\projects');
        expect(toHostPath('/home/me', windows), isNull);
        expect(toHostPath('repo', windows), isNull);
      },
    );

    test('POSIX hosts normalise slashes and refuse Windows paths', () {
      expect(toHostPath(' /home//me/./repo/ ', posix), '/home/me/repo');
      expect(toHostPath("'/srv/a b'", posix), '/srv/a b');
      expect(toHostPath('file:///home/me/x', posix), '/home/me/x');
      expect(toHostPath('/a/../../b', posix), '/b');
      expect(toHostPath('~/projects/', posix), '~/projects');
      expect(toHostPath(r'E:\work', posix), isNull);
      expect(toHostPath('relative', posix), isNull);
    });
  });

  group('breadcrumbs and names', () {
    test('split each style at its own separator', () {
      expect(hostPathCrumbs('/home/me'), [
        (name: '/', path: '/'),
        (name: 'home', path: '/home'),
        (name: 'me', path: '/home/me'),
      ]);
      expect(hostPathCrumbs(r'E:\work\repo'), [
        (name: 'E:', path: r'E:\'),
        (name: 'work', path: r'E:\work'),
        (name: 'repo', path: r'E:\work\repo'),
      ]);
      expect(hostPathCrumbs(r'E:\'), [(name: 'E:', path: r'E:\')]);
      expect(hostPathCrumbs(r'\\nas\share\repo').map((c) => c.name), [
        r'\\nas\share',
        'repo',
      ]);
      expect(hostPathName(r'E:\work\repo'), 'repo');
      expect(hostPathName('/'), '/');
    });
  });

  // Helpers only the app needs: hosts that predate `style`, and file URLs as
  // browsers read them.
  group('app helpers', () {
    test('a host style is reported or inferred from the paths it returned', () {
      expect(parseHostPathStyle('windows'), windows);
      expect(parseHostPathStyle('posix'), posix);
      expect(parseHostPathStyle(null), isNull);
      expect(inferHostPathStyle([r'E:\work', r'\\nas\share']), windows);
      expect(inferHostPathStyle(['/srv/proj']), posix);
      expect(inferHostPathStyle(['/srv/proj', r'E:\work']), isNull);
      expect(inferHostPathStyle([]), isNull);
    });

    test('file URLs keep drives, hosts and backslashes', () {
      expect(toHostPath('file://C:/work', windows), r'C:\work');
      expect(toHostPath(r'file:///C:\work\repo', windows), r'C:\work\repo');
      expect(toHostPath('file://nas/share/repo', windows), r'\\nas\share\repo');
      expect(toHostPath('file://localhost/srv/x', posix), '/srv/x');
      expect(toHostPath('file:///%E0%A4%A', posix), isNull);
    });

    test('containment compares whole folders', () {
      expect(hostPathWithin('/srv/proj/api', '/srv/proj'), isTrue);
      expect(hostPathWithin('/srv/proj', '/srv/proj'), isTrue);
      expect(hostPathWithin('/srv/project', '/srv/proj'), isFalse);
      expect(hostPathWithin(r'E:\work\repo', r'E:\'), isTrue);
      expect(hostPathWithin(r'E:\workshop', r'E:\work'), isFalse);
    });
  });
}
