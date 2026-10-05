import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_remote_mobile/main.dart';
import 'package:dsh_remote_mobile/src/models.dart';
import 'package:dsh_remote_mobile/src/repositories_page.dart';
import 'package:dsh_remote_mobile/src/store.dart';
import 'package:dsh_remote_mobile/src/theme.dart';

class FixtureStore extends RemoteStore {
  FixtureStore() {
    user = {'id': 'u', 'email': 'fixture@example.invalid'};
    controller = {'id': 'c'};
    connection = 'Live';
    setStatus('online');
    repositories['i'] = [
      RepositoryReference({
        'id': 'r1',
        'instanceId': 'i',
        'fullName': 'team/primary',
        'localPath': '/work/primary',
        'localState': 'verified',
        'selected': true,
        'authorization': 'manual',
        'branch': 'main',
      }),
      RepositoryReference({
        'id': 'r2',
        'instanceId': 'i',
        'fullName': 'team/secondary',
        'localPath': '/work/secondary',
        'localState': 'declared',
        'selected': true,
        'authorization': 'github_expired',
      }),
    ];
    githubStatus = {
      'configured': false,
      'state': 'disconnected',
      'nativeOAuthSupported': false,
    };
  }
  final mutations = <JsonMap>[];
  @override
  bool get signedIn => true;
  @override
  String get server => 'https://relay.example.invalid/';
  void setStatus(String status) {
    instances = [
      Instance.fromJson({
        'id': 'i',
        'name': 'Test host',
        'online': true,
        'status': status,
        'lastSeenAt': 1700000000000,
        'capabilities': [],
        'lease': {
          'controllerId': 'c',
          'epoch': 1,
          'expiresAt': DateTime.now()
              .add(const Duration(minutes: 5))
              .millisecondsSinceEpoch,
        },
      }),
    ];
    notifyListeners();
  }

  @override
  Future<void> refresh() async {}
  @override
  Future<Instance> refreshInstance(String id) async => instances.first;
  @override
  Future<JsonMap> refreshGithub() async => githubStatus!;
  @override
  Future<List<RepositoryReference>> refreshRepositories(String id) async =>
      repositories[id]!;
  @override
  Future<void> inspectRepository(String id, String referenceId) async {
    mutations.add({
      'action': 'repository.inspect',
      'repositoryId': referenceId,
      'args': {},
    });
    repositories[id] = repositories[id]!
        .map(
          (r) => r.id == referenceId
              ? RepositoryReference({...r.json, 'localState': 'verified'})
              : r,
        )
        .toList();
    notifyListeners();
  }

  @override
  Future<RepositoryReference> mapRepository(String id, JsonMap mapping) async {
    mutations.add({'mapping': mapping});
    final value = RepositoryReference({
      'id': 'r3',
      'instanceId': id,
      'fullName': 'team/new',
      'localPath': mapping['localPath'],
      'localState': 'declared',
      'authorization': 'manual',
      'selected': true,
    });
    repositories[id]!.add(value);
    notifyListeners();
    return value;
  }

  @override
  Future<JsonMap> githubInstallations({int page = 1}) async => {
    'installations': [
      {
        'id': 81,
        'account': {'login': 'team'},
      },
    ],
    'page': page,
    'hasMore': false,
  };
  @override
  Future<JsonMap> githubRepositories(
    int installationId, {
    int page = 1,
    int installationPage = 1,
  }) async => {
    'repositories': [
      {
        'id': 100 + page,
        'installationId': installationId,
        'fullName': 'team/repo$page',
        'defaultBranch': 'main',
        'private': true,
      },
    ],
    'page': page,
    'installationPage': installationPage,
    'hasMore': page == 1,
  };
  @override
  Future<Object?> command(
    String instanceId,
    String action,
    JsonMap args, {
    String? repositoryId,
    List<String>? repositoryIds,
  }) async {
    if (!readActions.contains(action)) {
      mutations.add({
        'action': action,
        'args': args,
        'repositoryId': repositoryId,
        'repositoryIds': repositoryIds,
      });
    }
    return switch (action) {
      'session.list' => [
        {'sessionId': 'session', 'title': 'A native conversation'},
      ],
      'session.read' => {'cursor': 0, 'title': 'A native conversation'},
      'session.page' => {'records': [], 'hasMore': false},
      'session.projections' => {'values': {}},
      _ => {},
    };
  }
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets(
      'native ${brightness.name} reference selection, preview, cancel and stale draft',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final store = FixtureStore();
        addTearDown(store.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: harnessTheme(brightness),
            home: SessionPage(
              store: store,
              instanceId: 'i',
              sessionId: 'session',
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), 'Keep this draft');
        await tester.tap(find.byTooltip('Repository references'));
        await tester.pumpAndSettle();
        expect(find.text('Repositories'), findsOneWidget);
        expect(
          tester.widget<Checkbox>(find.byType(Checkbox).at(1)).onChanged,
          isNull,
        );
        await tester.tap(find.byType(Checkbox).first);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Preview metadata').first);
        await tester.pumpAndSettle();
        expect(find.text('Message context preview'), findsOneWidget);
        expect(
          find.byWidgetPredicate(
            (w) =>
                w is SelectableText &&
                (w.data?.contains('untrusted_repository_data') ?? false),
          ),
          findsOneWidget,
        );
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Use 1 reference'));
        await tester.pumpAndSettle();
        expect(find.text('team/primary'), findsOneWidget);
        expect(find.text('Keep this draft'), findsOneWidget);
        store.setStatus('stale');
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<IconButton>(
                find.byWidgetPredicate(
                  (w) => w is IconButton && w.tooltip == 'Send prompt',
                ),
              )
              .onPressed,
          isNull,
        );
        expect(
          tester.widget<TextField>(find.byType(TextField)).enabled,
          isTrue,
        );
        expect(find.textContaining('Stale'), findsOneWidget);
        expect(store.mutations, isEmpty);
        final chip = tester.widget<InputChip>(find.byType(InputChip));
        chip.onDeleted!();
        await tester.pumpAndSettle();
        expect(find.text('team/primary'), findsNothing);
        expect(find.text('Keep this draft'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
  testWidgets(
    'native GitHub limitation and manual checkout mapping have safe exits',
    (tester) async {
      final store = FixtureStore();
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: harnessTheme(Brightness.light),
          home: RepositoriesPage(store: store, instanceId: 'i'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('GitHub'));
      await tester.pumpAndSettle();
      expect(find.text('GitHub is not configured'), findsOneWidget);
      expect(
        find.textContaining('Native OAuth is not supported'),
        findsOneWidget,
      );
      await tester.tap(find.text('Local references'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Map existing checkout'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'GitHub repository URL'),
        'https://github.com/team/new',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Existing absolute checkout path'),
        '/work/../new',
      );
      await tester.tap(find.text('Save reference'));
      await tester.pumpAndSettle();
      expect(find.textContaining('no traversal'), findsOneWidget);
      expect(store.mutations, isEmpty);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      await tester.tap(find.text('Map existing checkout'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'GitHub repository URL'),
        'https://github.com/team/new',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Existing absolute checkout path'),
        '/work/new',
      );
      await tester.tap(find.text('Save reference'));
      await tester.pumpAndSettle();
      expect(
        store.mutations.single['mapping'],
        containsPair('source', 'manual'),
      );
      expect(store.repositories['i']!.last.localState, 'declared');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'GitHub multi-repository selections retain exact discovery pages through mapping',
    (tester) async {
      final store = FixtureStore()
        ..githubStatus = {
          'configured': true,
          'state': 'connected',
          'account': {'login': 'fixture'},
          'nativeOAuthSupported': false,
        };
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: harnessTheme(Brightness.light),
          home: RepositoriesPage(store: store, instanceId: 'i'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('GitHub'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('team/repo1'));
      await tester.tap(find.text('team/repo1'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byTooltip('Next repositories'));
      await tester.tap(find.byTooltip('Next repositories'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('team/repo2'));
      await tester.tap(find.text('team/repo2'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Map 2 selected repositories'));
      await tester.tap(find.text('Map 2 selected repositories'));
      await tester.pumpAndSettle();
      expect(find.text('Bind existing checkouts'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(store.mutations, isEmpty);
      await tester.tap(find.text('Map 2 selected repositories'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'team/repo1'),
        '/work/one',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'team/repo2'),
        '/work/two',
      );
      await tester.tap(find.text('Save references'));
      await tester.pumpAndSettle();
      expect(store.mutations, hasLength(2));
      expect(object(store.mutations[0]['mapping']), containsPair('page', 1));
      expect(object(store.mutations[1]['mapping']), containsPair('page', 2));
      expect(
        object(store.mutations[0]['mapping']),
        containsPair('installationId', 81),
      );
      expect(
        object(store.mutations[0]['mapping']),
        containsPair('source', 'github'),
      );
      expect(find.textContaining('References declared'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('drawer dismiss and read-only navigation never acquire control', (
    tester,
  ) async {
    final store = FixtureStore()..setStatus('offline');
    addTearDown(store.dispose);
    await tester.pumpWidget(DshRemoteApp(store: store, restoreSession: false));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(700, 200));
    await tester.pumpAndSettle();
    expect(store.mutations, isEmpty);
    await tester.tap(find.text('Test host'));
    await tester.pumpAndSettle();
    expect(find.text('No heartbeat observed yet'), findsNothing);
    expect(find.textContaining('Last seen:'), findsOneWidget);
    expect(store.mutations, isEmpty);
  });
}
