// Opt-in integration with the actual relay, connector and upstream DSH Host.
// Only the OS credential backend is replaced with ephemeral test memory. All
// HTTP/WebSocket/DSH operations are real; the shared fixture scripts the model.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dsh_remote_mobile/main.dart';
import 'package:dsh_remote_mobile/src/credentials.dart';
import 'package:dsh_remote_mobile/src/models.dart';
import 'package:dsh_remote_mobile/src/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class EphemeralTestCredentials implements CredentialStore, CommandJournalStore {
  List<JsonMap> journal = [];
  @override
  Future<List<JsonMap>> readJournal() async =>
      journal.map((v) => Map<String, dynamic>.from(v)).toList();
  @override
  Future<void> saveJournal(List<JsonMap> entries) async {
    journal = entries.map((v) => Map<String, dynamic>.from(v)).toList();
  }

  JsonMap? value;
  @override
  Future<JsonMap?> read() async => value;
  @override
  Future<void> save({required String server, required String token}) async {
    value = {'server': server, 'token': token};
  }

  @override
  Future<void> clear() async => value = null;
}

class RealNetwork extends HttpOverrides {}

void main() {
  final fixturePath = Platform.environment['DSH_FIXTURE_PATH'];
  testWidgets(
    'actual widgets drive real DSH session, approval, settings and restoration',
    (tester) async {
      final fixture = object(jsonDecode(File(fixturePath!).readAsStringSync()));
      final previous = HttpOverrides.current;
      HttpOverrides.global = RealNetwork();
      addTearDown(() => HttpOverrides.global = previous);
      await tester.runAsync(() async {
        final sdk = Platform.environment['FLUTTER_ROOT'];
        if (sdk == null) return;
        for (final font in {
          'Roboto': 'Roboto-Regular.ttf',
          'MaterialIcons': 'MaterialIcons-Regular.otf',
        }.entries) {
          final file = File(
            '$sdk/bin/cache/artifacts/material_fonts/${font.value}',
          );
          if (!await file.exists()) continue;
          final loader = FontLoader(font.key)
            ..addFont(
              Future.value(ByteData.sublistView(await file.readAsBytes())),
            );
          await loader.load();
        }
        // flutter_tester has no system fallback fonts. Load the installed
        // Linux mono font for evidence; real devices retain their native face.
        final mono = File(
          '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
        );
        final monoFile = await mono.exists()
            ? mono
            : File(
                '$sdk/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf',
              );
        final monoLoader = FontLoader('monospace')
          ..addFont(
            Future.value(ByteData.sublistView(await monoFile.readAsBytes())),
          );
        await monoLoader.load();
      });
      await tester.binding.setSurfaceSize(const Size(430, 920));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final credentials = EphemeralTestCredentials();
      final store = RemoteStore(credentials: credentials, journal: credentials);
      RemoteStore? restored;
      var firstDisposed = false;
      addTearDown(() {
        if (!firstDisposed) store.dispose();
        restored?.dispose();
      });
      final capture = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: capture,
          child: DshRemoteApp(store: store, restoreSession: false),
        ),
      );

      Future<void> screenshot(String name) async {
        // Theme and nested Material text transitions each need a rendered frame.
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 350));
        await tester.pump(const Duration(milliseconds: 350));
        final bytes = await tester.runAsync(() async {
          final boundary =
              capture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1);
          return image.toByteData(format: ui.ImageByteFormat.png);
        });
        if (bytes != null) {
          File(
            '${File(fixturePath).parent.path}/$name.png',
          ).writeAsBytesSync(bytes.buffer.asUint8List());
        }
      }

      Future<void> until(
        bool Function() ready,
        String label, {
        int seconds = 30,
      }) async {
        final deadline = DateTime.now().add(Duration(seconds: seconds));
        while (!ready()) {
          final uiErrors = tester
              .widgetList<ErrorNotice>(find.byType(ErrorNotice))
              .map((notice) => notice.text)
              .toList();
          if (uiErrors.isNotEmpty) {
            throw StateError(
              'UI error while waiting for $label: ${uiErrors.join('; ')}',
            );
          }
          if (DateTime.now().isAfter(deadline)) {
            throw StateError(
              'Timed out: $label. Store error: ${store.error}. UI errors: ${tester.widgetList<ErrorNotice>(find.byType(ErrorNotice)).map((notice) => notice.text).join('; ')}. Commands: ${pretty(store.commands.values.map((c) => {'action': c.json['action'], 'status': c.status, 'error': c.json['error']}).toList())}',
            );
          }
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 100)),
          );
          await tester.pump(const Duration(milliseconds: 100));
        }
        await tester.pump();
      }

      Future<void> tap(Finder finder) async {
        await until(() {
          if (finder.evaluate().isEmpty) return false;
          final buttons = find.ancestor(
            of: finder.first,
            matching: find.byWidgetPredicate(
              (w) =>
                  w is ButtonStyleButton ||
                  w is IconButton ||
                  w is FloatingActionButton ||
                  w is PopupMenuButton<String>,
            ),
          );
          if (buttons.evaluate().isEmpty) return true;
          final button = tester.widget(buttons.first);
          if (button is ButtonStyleButton) return button.onPressed != null;
          if (button is IconButton) return button.onPressed != null;
          if (button is FloatingActionButton) return button.onPressed != null;
          if (button is PopupMenuButton<String>) return button.enabled;
          return true;
        }, 'enabled control: $finder');
        await tester.ensureVisible(finder.first);
        await tester.pump(const Duration(milliseconds: 350));
        await tester.tap(finder.first);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 350));
      }

      Future<void> latestDone(String action, int before) async {
        await until(() {
          final commands = store.commands.values
              .where((c) => c.json['action'] == action)
              .toList();
          return commands.length > before &&
              commands.last.status == 'succeeded';
        }, action);
        await until(
          () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
          'action UI settled',
        );
      }

      int count(String action) =>
          store.commands.values.where((c) => c.json['action'] == action).length;

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Relay server'),
        fixture['base'] as String,
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        fixture['email'] as String,
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        fixture['password'] as String,
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Controller name'),
        'Flutter real widget test',
      );
      await tap(find.text('Sign in'));
      await until(
        () =>
            store.signedIn &&
            find.text('Actual upstream source').evaluate().isNotEmpty,
        'signed-in fleet',
      );
      final originalController = store.controllerId;
      await tap(find.text('Actual upstream source'));
      await until(
        () => find.text('remote-e2e-b').evaluate().isNotEmpty,
        'passive session list',
      );
      expect(
        store
            .instance(fixture['instanceId'] as String)!
            .controlledBy(store.controllerId),
        isFalse,
      );
      await tap(find.text('remote-e2e-a'));
      await until(
        () =>
            tester
                .widget<IconButton>(
                  find.byWidgetPredicate(
                    (widget) =>
                        widget is IconButton &&
                        widget.tooltip == 'Load older history',
                  ),
                )
                .onPressed !=
            null,
        'passive paged history',
      );
      final pages = count('session.page');
      await tap(find.byTooltip('Load older history'));
      await latestDone('session.page', pages);
      await tap(find.byTooltip('Back'));
      await tap(find.text('Take over control'));
      await tap(find.text('Take over'));
      await until(
        () => store
            .instance(fixture['instanceId'] as String)!
            .controlledBy(store.controllerId),
        'acknowledged writer takeover',
      );
      await until(
        () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
        'control acquisition UI settled',
      );
      final createdBefore = count('session.create');
      await tap(find.text('New session'));
      await tap(find.text('Create session'));
      await latestDone('session.create', createdBefore);
      final created = store.commands.values.lastWhere(
        (c) => c.json['action'] == 'session.create',
      );
      final session = object(created.result)['sessionId'] as String;
      await until(
        () => find.text(session).evaluate().isNotEmpty,
        'new session in list',
      );
      await tap(find.text(session));
      await until(
        () =>
            find.byTooltip('Send prompt').evaluate().isNotEmpty &&
            count('session.projections') > 0,
        'session opened',
      );
      await until(
        () =>
            tester
                .widget<IconButton>(
                  find.byWidgetPredicate(
                    (widget) =>
                        widget is IconButton && widget.tooltip == 'Send prompt',
                  ),
                )
                .onPressed !=
            null,
        'composer enabled',
      );
      // Native selection uses the real relay's two already-mapped local worktrees.
      await tap(find.byTooltip('Repository references'));
      await until(
        () =>
            find.text('dsh-local-fixture/primary').evaluate().isNotEmpty &&
            find.byType(LinearProgressIndicator).evaluate().isEmpty,
        'real local repository list',
      );
      await tap(find.text('GitHub'));
      await until(
        () =>
            find.text('GitHub is not configured').evaluate().isNotEmpty &&
            find.byType(LinearProgressIndicator).evaluate().isEmpty,
        'native GitHub web-connect instruction',
      );
      expect(
        find.textContaining('Native OAuth is not supported'),
        findsOneWidget,
      );
      await tap(find.text('Local references'));
      final inspections = count('repository.inspect');
      await tap(find.text('Verify checkout').first);
      await latestDone('repository.inspect', inspections);
      final inspection = store.commands.values.lastWhere(
        (c) => c.json['action'] == 'repository.inspect',
      );
      expect(
        object(inspection.json['submittedBody'])['repositoryId'],
        isNotNull,
      );
      expect(object(object(inspection.json['submittedBody'])['args']), isEmpty);
      await tap(find.byType(Checkbox).first);
      await tap(find.byType(Checkbox).at(1));
      await tap(find.text('Preview metadata').first);
      expect(find.text('Message context preview'), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (w) =>
              w is SelectableText &&
              (w.data?.contains('untrusted_repository_data') ?? false),
        ),
        findsOneWidget,
      );
      await screenshot('flutter-context-preview-light');
      await tap(find.text('Close'));
      await tap(find.text('Use 2 references'));
      expect(find.byType(InputChip), findsNWidgets(2));
      final prompted = count('session.prompt');
      await tester.enterText(
        find.byType(TextField).last,
        'Flutter widget roundtrip ${newId()}',
      );
      await tap(find.byTooltip('Send prompt'));
      await latestDone('session.prompt', prompted);
      final sent = store.commands.values.lastWhere(
        (c) => c.json['action'] == 'session.prompt',
      );
      expect(object(sent.json['submittedBody'])['repositoryIds'], hasLength(2));
      expect(
        object(
          object(sent.json['submittedBody'])['args'],
        ).containsKey('repositoryContext'),
        isFalse,
      );

      await until(
        () => store.events.any(
          (event) =>
              event.kind == 'session.event' &&
              object(event.payload)['sessionId'] == session &&
              object(object(event.payload)['data'])['type'] ==
                  'assistant/message',
        ),
        'durable DSH assistant message',
      );
      await tap(find.byTooltip('Refresh session'));
      await until(
        () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
        'repository prompt history read',
      );
      final readCommand = store.commands.values.lastWhere(
        (c) => c.json['action'] == 'session.read',
      );
      final durable = pretty(readCommand.result);
      expect(durable, contains('Selected repository metadata: untrusted data'));
      expect(durable, contains('dsh-local-fixture/primary'));
      expect(durable, contains('dsh-local-fixture/secondary'));
      expect(
        durable,
        isNot(contains('REPOSITORY_CONFIG_SECRET_NOT_FOR_PROMPT')),
      );
      expect(
        durable,
        isNot(contains('REPOSITORY_FILE_CONTENT_NOT_FOR_PROMPT')),
      );

      await until(
        () => find
            .byWidgetPredicate(
              (w) =>
                  w is SelectableText &&
                  (w.data?.contains('REAL_DSH_PIPELINE_OK') ?? false),
            )
            .evaluate()
            .isNotEmpty,
        'rendered durable assistant answer',
      );

      final approvalPrompted = count('session.prompt');
      await tester.enterText(
        find.byType(TextField).last,
        'APPROVAL_INTEGRATION Flutter widget explicit consent',
      );
      await until(
        () =>
            tester
                .widget<IconButton>(
                  find.byWidgetPredicate(
                    (widget) =>
                        widget is IconButton && widget.tooltip == 'Send prompt',
                  ),
                )
                .onPressed !=
            null,
        'composer ready for approval',
      );
      await tap(find.byTooltip('Send prompt'));
      await latestDone('session.prompt', approvalPrompted);
      await until(
        () => find.text('Review and allow').evaluate().isNotEmpty,
        'actual pending approval card',
      );
      for (final text in ['MOBILE_QUEUE_ONE', 'MOBILE_QUEUE_TWO']) {
        final before = count('session.prompt');
        await tester.enterText(find.byType(TextField).last, text);
        await tap(find.byTooltip('Send prompt'));
        await latestDone('session.prompt', before);
      }
      await tap(
        find.descendant(
          of: find.byType(SegmentedButton<int>),
          matching: find.text('Queue'),
        ),
      );
      await until(
        () => find.text('Edit message').evaluate().isNotEmpty,
        'real queued messages rendered',
      );
      var queueUpdates = count('session.queue.update');
      await tap(find.text('Edit message').first);
      await tester.enterText(
        find.widgetWithText(TextField, 'Message text'),
        'MOBILE_EDITED_QUEUE',
      );
      await tap(find.text('Continue'));
      await latestDone('session.queue.update', queueUpdates);
      queueUpdates = count('session.queue.update');
      await tap(find.text('Prioritize next step').first);
      await latestDone('session.queue.update', queueUpdates);
      for (var i = 0; i < 2; i++) {
        queueUpdates = count('session.queue.update');
        await tap(find.text('Remove').first);
        await tap(find.text('Remove message'));
        await latestDone('session.queue.update', queueUpdates);
      }
      await tap(
        find.descendant(
          of: find.byType(SegmentedButton<int>),
          matching: find.text('Chat'),
        ),
      );
      final approvals = count('approval.respond');
      await tap(find.text('Review and allow'));
      expect(find.text('Allow this request once?'), findsOneWidget);
      await tap(find.text('Allow once'));
      await latestDone('approval.respond', approvals);
      await until(
        () => !store.pendingApprovals.values.any(
          (value) => value['sessionId'] == session,
        ),
        'approval settled snapshot',
      );
      await until(
        () => store.events.any(
          (event) =>
              event.kind == 'session.status' &&
              object(event.payload)['sessionId'] == session &&
              object(object(event.payload)['data'])['running'] == false,
        ),
        'model settlement',
      );

      await tap(find.byType(PopupMenuButton<String>));
      await tap(find.text('Settings and catalogs'));
      await until(
        () => find.text('Permission preset').evaluate().isNotEmpty,
        'actual settings catalog',
      );
      await tap(find.text('Permission preset'));
      await tap(find.text('read-only'));
      final updates = count('settings.update');
      await tap(find.text('Apply preset'));
      await latestDone('settings.update', updates);
      await screenshot('flutter-real-host');
      await tester.pumpWidget(
        RepaintBoundary(
          key: capture,
          child: DshRemoteApp(
            store: store,
            restoreSession: false,
            themeMode: ThemeMode.dark,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      await screenshot('flutter-real-host-dark');

      await tester.pumpWidget(const SizedBox());
      store.dispose();
      firstDisposed = true;
      restored = RemoteStore(credentials: credentials, journal: credentials);
      await tester.pumpWidget(DshRemoteApp(store: restored));
      await until(
        () => restored!.signedIn && !restored.busy,
        'secure-storage interface restart restoration',
      );
      expect(restored.controllerId, originalController);
      expect(find.text('Instances'), findsWidgets);
      await until(
        () => restored!.connection == 'Live',
        'restored event stream ready',
      );
      await tester.pumpWidget(const SizedBox());
      restored.dispose();
      restored = null;
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
      await tester.pump(const Duration(seconds: 16));
    },
    skip: fixturePath == null,
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
