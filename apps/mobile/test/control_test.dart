// Connecting takes control (remote-desktop style) and new sessions open in a
// folder chosen from the Host. A fake relay answers the real store's HTTP
// calls, so leases, takeover detection and commands run through RemoteStore.
import 'dart:async';
import 'dart:io';

import 'package:dsh_remote_mobile/main.dart';
import 'package:dsh_remote_mobile/src/api.dart';
import 'package:dsh_remote_mobile/src/credentials.dart';
import 'package:dsh_remote_mobile/src/models.dart';
import 'package:dsh_remote_mobile/src/store.dart';
import 'package:dsh_remote_mobile/src/theme.dart';
import 'package:dsh_remote_mobile/src/ui.dart';
import 'package:dsh_remote_mobile/src/workspace_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class MemoryJournal implements CommandJournalStore {
  List<JsonMap> entries = [];
  @override
  Future<List<JsonMap>> readJournal() async => List.of(entries);
  @override
  Future<void> saveJournal(List<JsonMap> value) async => entries = value;
}

/// One instance "i", this controller "c", and a Host with folders under
/// /srv/proj (allowed) and /home/me (reachable when [anyWorkspace] is on).
class FakeRelay extends RelayApi {
  FakeRelay({
    this.holder,
    this.capabilities = const [
      'session.list',
      'session.create',
      'workspace.list',
      'workspace.browse',
    ],
    this.roots = const [('proj', '/srv/proj')],
    this.anyWorkspace = false,
  }) : super('https://relay.example.invalid') {
    token = 'ephemeral-test';
  }
  String? holder;
  int epoch = 1;
  String status = 'online';
  final List<String> capabilities;
  final List<(String, String)> roots;
  final bool anyWorkspace;
  final controllers = <JsonMap>[
    {'id': 'c', 'name': 'This phone', 'active': true},
    {'id': 'laptop', 'name': 'Work laptop', 'active': true},
  ];
  final leaseRequests = <JsonMap>[];
  final reads = <JsonMap>[];
  final writes = <JsonMap>[];
  final sessions = <JsonMap>[];
  static const folders = {
    '/srv/proj': ['api', 'web'],
    '/srv/proj/api': <String>[],
    '/srv/proj/web': <String>[],
    '/home/me': ['locked'],
  };

  JsonMap get instance => {
    'id': 'i',
    'name': 'Studio',
    'online': status == 'online',
    'status': status,
    'lastSeenAt': 1700000000000,
    'capabilities': capabilities,
    'lease': holder == null
        ? null
        : {
            'controllerId': holder,
            'epoch': epoch,
            'pending': false,
            'expiresAt': DateTime.now()
                .add(const Duration(seconds: 30))
                .millisecondsSinceEpoch,
          },
  };

  Object? answer(String action, JsonMap args) {
    switch (action) {
      case 'session.list':
        return {'items': sessions};
      case 'session.create':
        sessions.add({
          'sessionId': args['sessionId'],
          'title': 'Session in ${args['cwd'] ?? 'the default folder'}',
        });
        return {'sessionId': args['sessionId']};
      case 'workspace.list':
        return {
          'roots': [
            for (final (name, path) in roots) {'name': name, 'path': path},
          ],
          'anyWorkspace': anyWorkspace,
        };
      case 'workspace.browse':
        final path = args['path'] as String?;
        if (path == null) {
          return {
            'path': null,
            'parent': null,
            'directories': [
              for (final (name, path) in roots) {'name': name, 'path': path},
              if (anyWorkspace) {'name': 'me', 'path': '/home/me'},
            ],
            'truncated': false,
          };
        }
        final children = folders[path];
        if (children == null) {
          throw const ApiException('access_denied', 'Cannot read');
        }
        final up = path.substring(0, path.lastIndexOf('/'));
        return {
          'path': path,
          'parent': folders.containsKey(up) || anyWorkspace ? up : null,
          'directories': [
            for (final name in children) {'name': name, 'path': '$path/$name'},
          ],
          'truncated': false,
        };
    }
    return {};
  }

  @override
  Future<JsonMap> request(String method, String path, [JsonMap? body]) async {
    if (path == 'api/instances') {
      return {
        'instances': [instance],
      };
    }
    if (path == 'api/controllers') return {'controllers': controllers};
    if (path.endsWith('/state')) return {'instance': instance};
    if (path.endsWith('/repositories')) return {'repositories': []};
    if (path.endsWith('/lease')) {
      leaseRequests.add({'method': method, ...?body});
      final me = body!['controllerId'] as String;
      if (method == 'DELETE') {
        holder = null;
        epoch++;
        return {'ok': true};
      }
      if (holder != null && holder != me && body['takeover'] != true) {
        throw const ApiException('LEASE_HELD', 'Another device holds it', 409);
      }
      if (holder != me) epoch++;
      holder = me;
      return object(instance['lease']);
    }
    if (path.endsWith('/commands')) {
      final action = body!['action'] as String;
      final args = object(body['args']);
      (readActions.contains(action) ? reads : writes).add({
        'action': action,
        'args': args,
      });
      try {
        return {
          'command': {
            ...body,
            'status': 'succeeded',
            'result': answer(action, args),
          },
        };
      } on ApiException catch (e) {
        return {
          'command': {
            ...body,
            'status': 'failed',
            'error': {'code': e.code, 'message': e.message},
          },
        };
      }
    }
    throw StateError('Unexpected request: $method $path');
  }

  /// The event stream never opens in these tests; "Live" is set directly.
  @override
  Future<WebSocket> connectEvents(int after) => Completer<WebSocket>().future;
}

Future<RemoteStore> connect(FakeRelay relay) async {
  final store = RemoteStore(journal: MemoryJournal())
    ..api = relay
    ..user = {'id': 'u'}
    ..controller = {'id': 'c'}
    ..connection = 'Live';
  await store.refresh();
  return store;
}

Widget app(Widget home) =>
    MaterialApp(theme: harnessTheme(Brightness.light), home: home);

Finder inDialog(Finder finder) =>
    find.descendant(of: find.byType(AlertDialog), matching: finder);

const takeoverText =
    'Taking over pushes that device off; it can only watch. Running tasks are not interrupted.';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('connecting takes a free instance without asking', (
    tester,
  ) async {
    final relay = FakeRelay();
    final store = await connect(relay);
    addTearDown(store.dispose);
    await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
    await tester.pumpAndSettle();
    expect(relay.leaseRequests, [
      {'method': 'POST', 'controllerId': 'c', 'takeover': false},
    ]);
    expect(store.canWrite('i'), isTrue);
    expect(find.text('In control'), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    // Being in control is kept: nothing else is acquired on later updates.
    await store.refresh();
    await tester.pumpAndSettle();
    expect(relay.leaseRequests, hasLength(1));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'another device in control is asked about once, and View only keeps watching',
    (tester) async {
      final relay = FakeRelay(holder: 'laptop');
      final store = await connect(relay);
      addTearDown(store.dispose);
      await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
      await tester.pumpAndSettle();
      expect(find.text('Work laptop is in control'), findsOneWidget);
      expect(find.text(takeoverText), findsOneWidget);
      await tester.tap(find.text('View only'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(store.isWatchOnly('i'), isTrue);
      // Neither a renewed lease nor a free one brings a prompt or an acquire.
      relay.epoch++;
      await store.refresh();
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      relay.holder = null;
      await store.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Take control'), findsOneWidget);
      relay.holder = 'laptop';
      relay.epoch++;
      await store.refresh();
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(relay.leaseRequests, isEmpty);
      // Taking over is explicit and confirmed.
      await tester.tap(find.text('Take over'));
      await tester.pumpAndSettle();
      expect(find.text('Work laptop is in control'), findsOneWidget);
      await tester.tap(inDialog(find.text('Take over')));
      await tester.pumpAndSettle();
      expect(relay.leaseRequests.single, containsPair('takeover', true));
      expect(find.text('In control'), findsOneWidget);
      expect(store.isWatchOnly('i'), isFalse);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'being taken over shows a notice instead of asking to take it back',
    (tester) async {
      final relay = FakeRelay();
      final store = await connect(relay);
      addTearDown(store.dispose);
      await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
      await tester.pumpAndSettle();
      expect(find.text('In control'), findsOneWidget);
      relay.holder = 'laptop';
      relay.epoch++;
      // As on the relay's lease.changed event.
      await store.refresh();
      await tester.pumpAndSettle();
      expect(
        find.text('Work laptop took over control. Watching only.'),
        findsOneWidget,
      );
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Take over'), findsOneWidget);
      expect(store.isWatchOnly('i'), isTrue);
      expect(relay.leaseRequests, hasLength(1));
      // The notice is the same on a session of that instance, and dismissible.
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        app(SessionPage(store: store, instanceId: 'i', sessionId: 's')),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('Work laptop took over control. Watching only.'),
        findsOneWidget,
      );
      expect(find.byType(AlertDialog), findsNothing);
      await tester.tap(find.byTooltip('Dismiss notice'));
      await tester.pumpAndSettle();
      expect(find.textContaining('took over control'), findsNothing);
      expect(relay.leaseRequests, hasLength(1));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'New session picks a folder on the Host, browsing into a subfolder',
    (tester) async {
      final relay = FakeRelay();
      final store = await connect(relay);
      addTearDown(store.dispose);
      await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
      await tester.pumpAndSettle();
      expect(find.text('No sessions'), findsOneWidget);
      // In the heading and, with no sessions yet, in the empty state.
      expect(find.text('New session'), findsNWidgets(2));
      await tester.tap(find.text('New session').last);
      await tester.pumpAndSettle();
      expect(inDialog(find.text('New session')), findsOneWidget);
      expect(find.text('Workspace folder'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      // The allowed folder is preselected.
      expect(inDialog(find.text('/srv/proj')), findsOneWidget);
      expect(inDialog(find.byIcon(Icons.check_rounded)), findsOneWidget);
      await tester.tap(find.text('Choose subfolder'));
      await tester.pumpAndSettle();
      expect(find.text('/srv/proj'), findsOneWidget);
      expect(find.text('web'), findsOneWidget);
      // Up from the edge of what may be listed returns to the starting places.
      await tester.tap(find.text('Up'));
      await tester.pumpAndSettle();
      expect(find.text('Allowed folders'), findsOneWidget);
      expect(find.text('Up'), findsNothing);
      await tester.tap(find.text('proj'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('api'));
      await tester.pumpAndSettle();
      expect(find.text('/srv/proj/api'), findsOneWidget);
      expect(find.text('No subfolders'), findsOneWidget);
      await tester.tap(find.text('Use this folder'));
      await tester.pumpAndSettle();
      // The chosen folder leads the list, selected.
      expect(find.text('Workspace folder'), findsOneWidget);
      final rows = tester
          .widgetList<FolderRow>(find.byType(FolderRow))
          .toList();
      expect(rows.map((row) => row.subtitle), ['/srv/proj/api', '/srv/proj']);
      expect(rows.map((row) => row.selected), [true, false]);
      await tester.tap(find.widgetWithText(FilledButton, 'Create session'));
      await tester.pumpAndSettle();
      expect(relay.writes, hasLength(1));
      expect(relay.writes.single['action'], 'session.create');
      final args = object(relay.writes.single['args']);
      expect(args['cwd'], '/srv/proj/api');
      expect(args['sessionId'], isA<String>());
      expect(
        relay.reads
            .where((r) => r['action'] == 'workspace.browse')
            .map((r) => object(r['args'])['path']),
        ['/srv/proj', null, '/srv/proj', '/srv/proj/api'],
      );
      expect(find.text('Session in /srv/proj/api'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a plugin without the folder picker keeps the confirmation', (
    tester,
  ) async {
    final relay = FakeRelay(capabilities: const ['session.create']);
    final store = await connect(relay);
    addTearDown(store.dispose);
    await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New session').first);
    await tester.pumpAndSettle();
    expect(find.text('New session?'), findsOneWidget);
    expect(
      find.text(
        'Create a session in the connector’s configured default workspace.',
      ),
      findsOneWidget,
    );
    expect(find.text('Workspace folder'), findsNothing);
    await tester.tap(find.text('Create session'));
    await tester.pumpAndSettle();
    expect(
      relay.reads.map((r) => r['action']),
      isNot(contains('workspace.list')),
    );
    final args = object(relay.writes.single['args']);
    expect(args.containsKey('cwd'), isFalse);
    expect(args['sessionId'], isA<String>());
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'New session acquires a released instance and takes over after asking',
    (tester) async {
      final relay = FakeRelay();
      final store = await connect(relay);
      addTearDown(store.dispose);
      await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
      await tester.pumpAndSettle();
      // Releasing leaves the instance watch-only.
      await tester.tap(find.text('In control'));
      await tester.pumpAndSettle();
      expect(relay.leaseRequests.last['method'], 'DELETE');
      expect(find.text('Take control'), findsOneWidget);
      expect(store.isWatchOnly('i'), isTrue);
      expect(relay.leaseRequests, hasLength(2));
      // A free lease is acquired, then the folder is chosen.
      await tester.tap(find.text('New session').first);
      await tester.pumpAndSettle();
      expect(relay.leaseRequests.last, containsPair('takeover', false));
      expect(find.text('Workspace folder'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      // Another device's control is only taken after confirming.
      relay.holder = 'laptop';
      relay.epoch++;
      await store.refresh();
      await tester.pumpAndSettle();
      await tester.tap(find.text('New session').first);
      await tester.pumpAndSettle();
      expect(find.text('Work laptop is in control'), findsOneWidget);
      await tester.tap(inDialog(find.text('Take over')));
      await tester.pumpAndSettle();
      expect(relay.leaseRequests.last, containsPair('takeover', true));
      expect(find.text('Workspace folder'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(relay.writes, isEmpty);
      expect(find.text('In control'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('an offline instance shows no control and acquires nothing', (
    tester,
  ) async {
    final relay = FakeRelay()..status = 'offline';
    final store = await connect(relay);
    addTearDown(store.dispose);
    await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
    await tester.pumpAndSettle();
    expect(find.byType(ControlButton), findsNothing);
    expect(relay.leaseRequests, isEmpty);
    expect(
      tester
          .widget<TextButton>(
            find.ancestor(
              of: find.text('New session'),
              matching: find.byWidgetPredicate((w) => w is TextButton),
            ),
          )
          .onPressed,
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the folder picker explains an empty allowlist and Host errors', (
    tester,
  ) async {
    final empty = FakeRelay(roots: const []);
    final store = await connect(empty);
    addTearDown(store.dispose);
    await tester.pumpWidget(app(InstancePage(store: store, id: 'i')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New session').first);
    await tester.pumpAndSettle();
    expect(
      find.textContaining('This host has no folders allowed for remote'),
      findsOneWidget,
    );
    expect(find.text('Choose subfolder'), findsNothing);
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Create session'),
          )
          .onPressed,
      isNull,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpWidget(const SizedBox());

    final open = FakeRelay(roots: const [], anyWorkspace: true);
    final anywhere = await connect(open);
    addTearDown(anywhere.dispose);
    await tester.pumpWidget(app(InstancePage(store: anywhere, id: 'i')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New session').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Browse other folders'));
    await tester.pumpAndSettle();
    expect(find.text('This computer'), findsOneWidget);
    await tester.tap(find.text('me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('locked'));
    await tester.pumpAndSettle();
    expect(
      find.text('That folder can\'t be read on the host.'),
      findsOneWidget,
    );
    // The folder that could be read stays on screen.
    expect(find.text('/home/me'), findsOneWidget);
    await tester.tap(find.text('Use this folder'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create session'));
    await tester.pumpAndSettle();
    expect(object(open.writes.single['args'])['cwd'], '/home/me');
    await tester.pumpWidget(const SizedBox());
  });

  group('store', () {
    test(
      'control is never taken in the background; a reconnect resumes ours once',
      () async {
        final relay = FakeRelay();
        final store = await connect(relay);
        addTearDown(store.dispose);
        expect(store.autoControlStep('i'), AutoControl.acquire);
        // Each lease state is handled once, so a failure cannot loop.
        expect(store.autoControlStep('i'), isNull);
        await store.acquire('i');
        expect(store.canWrite('i'), isTrue);
        expect(store.autoControlStep('i'), isNull);
        store.didChangeAppLifecycleState(AppLifecycleState.paused);
        expect(store.canWrite('i'), isFalse);
        store.connection = 'Live';
        expect(store.autoControlStep('i'), isNull);
        store.didChangeAppLifecycleState(AppLifecycleState.resumed);
        await pumpEventQueue();
        store.connection = 'Live';
        expect(store.autoControlStep('i'), AutoControl.resume);
        expect(store.autoControlStep('i'), isNull);
        await store.acquire('i');
        expect(store.canWrite('i'), isTrue);
        // Renewal keeps the epoch: the fences of earlier writes still hold.
        expect(relay.epoch, 2);
      },
    );

    test('a watch-only instance is never acquired automatically', () async {
      final relay = FakeRelay();
      final store = await connect(relay);
      addTearDown(store.dispose);
      store.setWatchOnly('i', true);
      expect(store.autoControlStep('i'), isNull);
      relay.epoch++;
      await store.refresh();
      expect(store.autoControlStep('i'), isNull);
      // Asking for control is explicit and is not followed by an automatic
      // step for the same lease state.
      store.setWatchOnly('i', false);
      expect(store.autoControlStep('i'), isNull);
    });

    test(
      'takeovers are announced once, by name when it can be found',
      () async {
        final relay = FakeRelay(holder: 'c');
        final store = await connect(relay);
        addTearDown(store.dispose);
        // A device that signed in after the list loaded is looked up.
        relay.controllers.add({'id': 'tablet', 'name': 'Kitchen tablet'});
        relay.holder = 'tablet';
        relay.epoch++;
        await store.refreshInstance('i');
        await pumpEventQueue();
        expect(
          store.controlNotices['i'],
          'Kitchen tablet took over control. Watching only.',
        );
        expect(store.isWatchOnly('i'), isTrue);
        expect(store.autoControlStep('i'), isNull);
        store.dismissControlNotice('i');
        await store.refresh();
        await pumpEventQueue();
        expect(store.controlNotices, isEmpty);
        // Back in control, then pushed off by a device the relay cannot name.
        relay.holder = 'c';
        await store.refreshInstance('i');
        relay.holder = 'unknown';
        relay.epoch++;
        await store.refreshInstance('i');
        await pumpEventQueue();
        expect(
          store.controlNotices['i'],
          'Another device took over control. Watching only.',
        );
      },
    );

    test('Host folder errors read as plain English', () {
      String text(String code) =>
          workspaceErrorText(ApiException(code, 'raw $code'));
      expect(
        text('workspace_forbidden'),
        'That folder is outside what this host allows remotely.',
      );
      expect(
        text('no_workspace'),
        'This host has no folders allowed for remote sessions yet.',
      );
      expect(text('not_found'), 'That folder no longer exists.');
      expect(text('not_a_directory'), 'That is not a folder.');
      expect(text('access_denied'), 'That folder can\'t be read on the host.');
      expect(text('timeout'), 'raw timeout');
    });
  });
}
