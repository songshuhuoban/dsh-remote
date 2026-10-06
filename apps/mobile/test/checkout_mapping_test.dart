// Mapping a checkout and finding GitHub repositories on the repositories
// page, against the fake relay of control_test.dart: checkout folders are
// chosen on the Host while it can browse, and the GitHub App is installed
// from the page when it has no installation yet.
import 'package:dsh_remote_mobile/src/host_path.dart';
import 'package:dsh_remote_mobile/src/repositories_page.dart';
import 'package:dsh_remote_mobile/src/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'control_test.dart' show FakeRelay, app, browsed, connect, crumbs;

const connectedGithub = {
  'configured': true,
  'state': 'connected',
  'account': {'login': 'octo'},
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('mapping a checkout chooses its folder on the Host', (
    tester,
  ) async {
    final relay = FakeRelay();
    final store = await connect(relay);
    addTearDown(store.dispose);
    await tester.pumpWidget(
      app(RepositoriesPage(store: store, instanceId: 'i')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Map existing checkout'));
    await tester.pumpAndSettle();
    // Nothing to type: the picker is available.
    expect(
      find.widgetWithText(TextFormField, 'Existing absolute checkout path'),
      findsNothing,
    );
    expect(find.text(folderPickerUnavailable), findsNothing);
    await tester.enterText(
      find.widgetWithText(TextFormField, 'GitHub repository URL'),
      'https://github.com/team/new',
    );
    await tester.tap(find.text('Save reference'));
    await tester.pumpAndSettle();
    expect(find.text('Choose the existing checkout folder.'), findsOneWidget);
    expect(relay.mappings, isEmpty);

    await tester.tap(find.text('Choose folder'));
    await tester.pumpAndSettle();
    // The picker opens over the mapping dialog, straight in its browser.
    expect(find.byType(AlertDialog), findsNWidgets(2));
    expect(find.text('Allowed folders'), findsOneWidget);
    expect(find.text('Create session'), findsNothing);
    await tester.tap(find.text('proj'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('api'));
    await tester.pumpAndSettle();
    expect(crumbs(tester), '/srv/proj/api');
    await tester.tap(find.text('Use this folder'));
    await tester.pumpAndSettle();
    // The chosen folder reads back in the mapping dialog, with Change.
    expect(find.text('Map existing checkout'), findsWidgets);
    expect(find.text('/srv/proj/api'), findsOneWidget);
    expect(find.text('Choose the existing checkout folder.'), findsNothing);
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    expect(browsed(relay).last, '/srv/proj/api');
    await tester.tap(find.text('Cancel').last);
    await tester.pumpAndSettle();
    expect(find.text('/srv/proj/api'), findsOneWidget);

    await tester.tap(find.text('Save reference'));
    await tester.pumpAndSettle();
    expect(relay.mappings.single, {
      'source': 'manual',
      'url': 'https://github.com/team/new',
      'localPath': '/srv/proj/api',
      'defaultBranch': 'main',
      'controllerId': 'c',
    });
    expect(find.textContaining('Reference declared'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'offline, the checkout path is typed and converted to the host’s style',
    (tester) async {
      final relay = FakeRelay()..status = 'offline';
      final store = await connect(relay);
      addTearDown(store.dispose);
      // Learnt from the host's folder list while it was online.
      store.hostStyles['i'] = HostPathStyle.windows;
      await tester.pumpWidget(
        app(RepositoriesPage(store: store, instanceId: 'i')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Map existing checkout'));
      await tester.pumpAndSettle();
      expect(find.text(folderPickerUnavailable), findsOneWidget);
      expect(find.text('Choose folder'), findsNothing);
      await tester.enterText(
        find.widgetWithText(TextFormField, 'GitHub repository URL'),
        'https://github.com/team/new',
      );
      final path = find.widgetWithText(
        TextFormField,
        'Existing absolute checkout path',
      );
      await tester.enterText(path, '/home/me/repo');
      await tester.tap(find.text('Save reference'));
      await tester.pumpAndSettle();
      expect(
        find.text(r'Use an absolute path on this host, like C:\work\repo.'),
        findsOneWidget,
      );
      await tester.enterText(path, 'e:/work/repo/');
      await tester.pump();
      expect(find.text(r'Saved as E:\work\repo'), findsOneWidget);
      await tester.tap(find.text('Save reference'));
      await tester.pumpAndSettle();
      expect(relay.mappings.single['localPath'], r'E:\work\repo');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('GitHub without an installation offers to install the App', (
    tester,
  ) async {
    final relay = FakeRelay()..github = connectedGithub;
    final store = await connect(relay);
    addTearDown(store.dispose);
    final opened = <Uri>[];
    await tester.pumpWidget(
      app(
        RepositoriesPage(
          store: store,
          instanceId: 'i',
          openUrl: (url) async {
            opened.add(url);
            return true;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('GitHub'));
    await tester.pumpAndSettle();
    expect(find.text('Connected as octo'), findsOneWidget);
    expect(
      find.text(
        'Install DSH Remote on GitHub and choose the repositories it may read.',
      ),
      findsOneWidget,
    );
    expect(
      find.widgetWithText(FilledButton, 'Install on GitHub'),
      findsOneWidget,
    );
    // Said once: the empty state's Refresh replaces the general one.
    expect(find.text('Refresh GitHub access'), findsNothing);
    expect(find.byType(DropdownButton<int>), findsNothing);
    expect(find.textContaining('Installation page'), findsNothing);
    await tester.tap(find.text('Install on GitHub'));
    await tester.pumpAndSettle();
    expect(relay.githubRequests, contains('POST api/github/install'));
    expect(opened, [Uri.parse(FakeRelay.installUrl)]);

    // Installed on GitHub with one repository chosen; Refresh shows it.
    relay
      ..installations = [
        {
          'id': 7,
          'account': {'login': 'octo'},
        },
      ]
      ..githubRepositories = {
        7: [
          {
            'id': 1,
            'installationId': 7,
            'fullName': 'octo/app',
            'defaultBranch': 'main',
            'private': true,
          },
        ],
      };
    await tester.tap(find.widgetWithText(TextButton, 'Refresh'));
    await tester.pumpAndSettle();
    expect(find.text('octo/app'), findsOneWidget);
    expect(find.textContaining('Install DSH Remote on GitHub'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a single GitHub installation is used at once and its checkout chosen on the Host',
    (tester) async {
      final relay = FakeRelay()
        ..github = connectedGithub
        ..installations = [
          {
            'id': 7,
            'account': {'login': 'octo'},
          },
        ]
        ..githubRepositories = {
          7: [
            {
              'id': 1,
              'installationId': 7,
              'fullName': 'octo/app',
              'defaultBranch': 'main',
              'private': true,
            },
          ],
        };
      final store = await connect(relay);
      addTearDown(store.dispose);
      await tester.pumpWidget(
        app(RepositoriesPage(store: store, instanceId: 'i')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('GitHub'));
      await tester.pumpAndSettle();
      expect(relay.githubRequests, [
        'GET api/github/installations?page=1',
        'GET api/github/repositories?installationId=7&page=1&installationPage=1',
      ]);
      expect(find.text('octo/app'), findsOneWidget);
      // One installation, one page: nothing to choose or page through.
      expect(find.byType(DropdownButton<int>), findsNothing);
      expect(find.textContaining('Installation page'), findsNothing);
      expect(find.textContaining('Repository page'), findsNothing);

      await tester.tap(find.text('octo/app'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Map 1 selected repositories'));
      await tester.pumpAndSettle();
      expect(find.text('Bind existing checkouts'), findsOneWidget);
      expect(find.text('octo/app'), findsWidgets);
      await tester.tap(find.text('Choose folder'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('proj'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use this folder'));
      await tester.pumpAndSettle();
      expect(find.text('/srv/proj'), findsOneWidget);
      await tester.tap(find.text('Save references'));
      await tester.pumpAndSettle();
      expect(relay.mappings.single, {
        'source': 'github',
        'repositoryId': 1,
        'installationId': 7,
        'page': 1,
        'installationPage': 1,
        'localPath': '/srv/proj',
        'controllerId': 'c',
      });
      expect(find.textContaining('References declared'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'the chooser’s path field and chosen folder appear at once with reduced motion',
    (tester) async {
      final relay = FakeRelay();
      final store = await connect(relay);
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: harnessTheme(Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: RepositoriesPage(store: store, instanceId: 'i'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Map existing checkout'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Choose folder'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('proj'));
      await tester.pumpAndSettle();
      bool shown(Finder finder) => tester
          .widgetList<FadeTransition>(
            find.ancestor(of: finder, matching: find.byType(FadeTransition)),
          )
          .every((fade) => fade.opacity.value == 1);
      await tester.tap(find.byTooltip('Go to path'));
      await tester.pump();
      final field = find.widgetWithText(TextField, 'Go to path');
      expect(field, findsOneWidget);
      expect(shown(field), isTrue);
      await tester.tap(find.text('Use this folder'));
      await tester.pumpAndSettle();
      expect(find.text('/srv/proj'), findsOneWidget);
      expect(shown(find.text('/srv/proj')), isTrue);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
