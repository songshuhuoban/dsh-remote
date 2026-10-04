import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_remote_mobile/src/api.dart';
import 'package:dsh_remote_mobile/src/credentials.dart';
import 'package:dsh_remote_mobile/src/models.dart';
import 'package:dsh_remote_mobile/src/store.dart';
import 'package:dsh_remote_mobile/src/repositories_page.dart';

class RecordingApi extends RelayApi {
  RecordingApi() : super('https://relay.example.invalid') {
    token = 'ephemeral-test';
  }
  final requests = <JsonMap>[];
  String status = 'online';
  ApiException? postFailure;
  bool missingResult = false;
  JsonMap? lastBody;
  JsonMap get instance => {
    'id': 'i',
    'name': 'Host',
    'online': true,
    'status': status,
    'lastSeenAt': 1700000000000,
    'capabilities': [],
    'lease': {
      'controllerId': 'c',
      'epoch': 7,
      'pending': false,
      'expiresAt': DateTime.now()
          .add(const Duration(minutes: 1))
          .millisecondsSinceEpoch,
    },
  };
  @override
  Future<JsonMap> request(String method, String path, [JsonMap? body]) async {
    requests.add({'method': method, 'path': path, 'body': body});
    if (path.endsWith('/state')) return {'instance': instance};
    if (path.startsWith('api/commands/')) {
      if (missingResult) {
        throw const ApiException('NOT_FOUND', 'Not found yet', 404);
      }
      return {
        'command': {...lastBody!, 'status': 'succeeded', 'result': {}},
      };
    }
    if (path.endsWith('/commands')) {
      lastBody = body;
      if (postFailure != null) throw postFailure!;
      return {
        'command': {...body!, 'status': 'succeeded', 'result': {}},
      };
    }
    throw StateError('Unexpected request: $method $path');
  }
}

class MemoryJournal implements CommandJournalStore {
  List<JsonMap> entries = [];
  bool fail = false;
  @override
  Future<List<JsonMap>> readJournal() async =>
      entries.map((e) => Map<String, dynamic>.from(e)).toList();
  @override
  Future<void> saveJournal(List<JsonMap> value) async {
    if (fail) throw StateError('Locked');
    entries = value.map((e) => Map<String, dynamic>.from(e)).toList();
  }
}

class PausedJournal extends MemoryJournal {
  final started = Completer<void>();
  final resume = Completer<void>();
  int saves = 0;
  @override
  Future<void> saveJournal(List<JsonMap> value) async {
    if (saves++ == 0) {
      started.complete();
      await resume.future;
    }
    await super.saveJournal(value);
  }
}

RemoteStore storeFor(RecordingApi api, {MemoryJournal? journal}) =>
    RemoteStore(journal: journal ?? MemoryJournal())
      ..api = api
      ..user = {'id': 'u'}
      ..controller = {'id': 'c'}
      ..connection = 'Live'
      ..instances = [Instance.fromJson(api.instance)];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'authoritative stale status wins over legacy online and current lease',
    () {
      final api = RecordingApi()..status = 'stale';
      final current = Instance.fromJson(api.instance);
      expect(current.online, isFalse);
      expect(current.statusLabel, 'Stale · read-only');
      expect(current.controlledBy('c'), isFalse);
      expect(current.lastSeenAt!.millisecondsSinceEpoch, 1700000000000);
      api.close();
    },
  );
  test('stale preflight cannot submit a mutation', () async {
    final api = RecordingApi();
    final store = storeFor(api);
    addTearDown(store.dispose);
    api.status = 'stale';
    await expectLater(
      store.command('i', 'session.prompt', {'sessionId': 's'}),
      throwsA(isA<ApiException>()),
    );
    expect(api.requests.where((r) => r['method'] == 'POST'), isEmpty);
    expect(store.canWrite('i'), isFalse);
  });
  test('inspect and prompt send reference IDs only at top level', () async {
    final api = RecordingApi();
    final store = storeFor(api);
    addTearDown(store.dispose);
    await store.command('i', 'repository.inspect', {}, repositoryId: 'repo_1');
    expect(api.lastBody!['repositoryId'], 'repo_1');
    expect(api.lastBody!['args'], isEmpty);
    expect(api.lastBody!['leaseEpoch'], 7);
    await store.command(
      'i',
      'session.prompt',
      {'sessionId': 's', 'content': []},
      repositoryIds: ['repo_1', 'repo_2'],
    );
    expect(api.lastBody!['repositoryIds'], ['repo_1', 'repo_2']);
    expect(
      object(api.lastBody!['args']).containsKey('repositoryContext'),
      isFalse,
    );
    await expectLater(
      store.command('i', 'session.prompt', {'repositoryContext': []}),
      throwsA(isA<ApiException>()),
    );
    await expectLater(
      store.command(
        'i',
        'session.prompt',
        {},
        repositoryIds: List.generate(9, (i) => 'r$i'),
      ),
      throwsA(isA<ApiException>()),
    );
  });
  test(
    'uncertain submission retains original ID and body; 404 never resends',
    () async {
      final api = RecordingApi()
        ..postFailure = const ApiException('connection_failed', 'Network lost');
      final store = storeFor(api);
      addTearDown(store.dispose);
      await expectLater(
        store.command('i', 'session.prompt', {
          'sessionId': 's',
          'requestId': 'request-original',
        }),
        throwsA(isA<ApiException>()),
      );
      final original = store.commands.values.single;
      expect(original.status, 'indeterminate');
      expect(original.json['submittedBody'], api.lastBody);
      expect(store.hasUnresolvedWrite('i'), isTrue);
      api.missingResult = true;
      await expectLater(
        store.checkCommand(original.id),
        throwsA(isA<ApiException>()),
      );
      await expectLater(
        store.command('i', 'session.prompt', {'sessionId': 's'}),
        throwsA(isA<ApiException>()),
      );
      expect(api.requests.where((r) => r['method'] == 'POST'), hasLength(1));
      expect(store.commands.keys.single, original.id);
      api.missingResult = false;
      await store.checkCommand(original.id);
      expect(store.commands[original.id]!.status, 'succeeded');
      expect(store.hasUnresolvedWrite('i'), isFalse);
    },
  );
  test(
    'deterministic rejected POST is failed and does not block next command',
    () async {
      final api = RecordingApi()
        ..postFailure = const ApiException('CONFLICT', 'Rejected', 409);
      final store = storeFor(api);
      addTearDown(store.dispose);
      await expectLater(
        store.command('i', 'session.prompt', {'sessionId': 's'}),
        throwsA(isA<ApiException>()),
      );
      expect(store.commands.values.single.status, 'failed');
      expect(store.hasUnresolvedWrite('i'), isFalse);
    },
  );
  test(
    'disconnected transport is read-only despite cached online writer',
    () async {
      final api = RecordingApi();
      final store = storeFor(api);
      addTearDown(store.dispose);
      store.connection = 'Reconnecting';
      expect(store.canWrite('i'), isFalse);
      await expectLater(
        store.command('i', 'repository.inspect', {}, repositoryId: 'r'),
        throwsA(isA<ApiException>()),
      );
      expect(api.requests, isEmpty);
      await store.command('i', 'session.list', {});
      expect(api.requests.single['method'], 'POST');
    },
  );
  test(
    'context preview is metadata-only and selection requires local verification',
    () {
      final reference = RepositoryReference({
        'id': 'r',
        'instanceId': 'i',
        'fullName': 'team/repo',
        'localPath': '/work/repo',
        'localState': 'verified',
        'authorization': 'github_expired',
        'token': 'never-preview',
        'fileContents': 'never-preview',
      });
      expect(repositorySelectionError([reference], 'i'), isNull);
      expect(
        pretty(reference.contextPreview),
        isNot(contains('never-preview')),
      );
      expect(
        reference.contextPreview['sourceTrust'],
        'untrusted_repository_data',
      );
      expect(repositorySelectionError([reference, reference], 'i'), isNotNull);
      expect(
        repositorySelectionError([reference], 'another-instance'),
        isNotNull,
      );
      expect(
        repositorySelectionError([
          RepositoryReference({...reference.json, 'localState': 'stale'}),
        ], 'i'),
        isNotNull,
      );
    },
  );
  test(
    'process recreation restores unresolved IDs without payload and never resends',
    () async {
      final journal = MemoryJournal();
      final api = RecordingApi()
        ..postFailure = const ApiException(
          'connection_failed',
          'Lost after dispatch',
        );
      final first = storeFor(api, journal: journal);
      await expectLater(
        first.command('i', 'session.prompt', {
          'sessionId': 's',
          'content': [
            {'type': 'file', 'data': 'NEVER_STORE_ATTACHMENT'},
          ],
        }),
        throwsA(isA<ApiException>()),
      );
      final id = first.commands.keys.single;
      expect(journal.entries.single['id'], id);
      expect(
        pretty(journal.entries),
        isNot(contains('NEVER_STORE_ATTACHMENT')),
      );
      first.dispose();
      final secondApi = RecordingApi()
        ..lastBody = {'id': id, 'action': 'session.prompt'};
      final restored = storeFor(secondApi, journal: journal);
      addTearDown(restored.dispose);
      await restored.restoreCommandJournal();
      expect(restored.commands[id]!.status, 'indeterminate');
      expect(restored.commands[id]!.json['submittedBodyUnavailable'], isTrue);
      await expectLater(
        restored.command('i', 'session.prompt', {'sessionId': 's'}),
        throwsA(isA<ApiException>()),
      );
      expect(secondApi.requests, isEmpty);
      await restored.checkCommand(id);
      expect(journal.entries, isEmpty);
      expect(restored.hasUnresolvedWrite('i'), isFalse);
    },
  );
  test(
    'journal write failure rejects safely before network dispatch',
    () async {
      final journal = MemoryJournal()..fail = true;
      final api = RecordingApi();
      final store = storeFor(api, journal: journal);
      addTearDown(store.dispose);
      await expectLater(
        store.command('i', 'session.prompt', {'sessionId': 's'}),
        throwsA(isA<ApiException>()),
      );
      expect(api.requests.where((r) => r['method'] == 'POST'), isEmpty);
      expect(store.journalError, contains('not sent'));
      expect(store.canWrite('i'), isFalse);
    },
  );
  test('journal restoration filters account and server identity', () async {
    final journal = MemoryJournal()
      ..entries = [
        {
          'id': 'foreign',
          'server': 'https://other.invalid/',
          'userId': 'u',
          'controllerId': 'c',
          'instanceId': 'i',
          'action': 'session.prompt',
        },
      ];
    final api = RecordingApi();
    final store = storeFor(api, journal: journal);
    addTearDown(store.dispose);
    await store.restoreCommandJournal();
    expect(store.commands, isEmpty);
  });
  test(
    'cancel during journal persistence does not dispatch or leave a false unknown',
    () async {
      final journal = PausedJournal();
      final api = RecordingApi();
      final store = storeFor(api, journal: journal);
      addTearDown(store.dispose);
      final command = store.command('i', 'session.prompt', {'sessionId': 's'});
      final rejected = expectLater(command, throwsA(isA<ApiException>()));
      await journal.started.future;
      store.abandonControl('i');
      journal.resume.complete();
      await rejected;
      expect(api.requests.where((r) => r['method'] == 'POST'), isEmpty);
      expect(journal.entries, isEmpty);
    },
  );
  test(
    'a full unresolved journal rejects before dispatch without eviction',
    () async {
      final journal = MemoryJournal()
        ..entries = List.generate(64, (i) => {'id': 'old-$i'});
      final api = RecordingApi();
      final store = storeFor(api, journal: journal);
      addTearDown(store.dispose);
      await expectLater(
        store.command('i', 'session.prompt', {'sessionId': 's'}),
        throwsA(isA<ApiException>()),
      );
      expect(api.requests.where((r) => r['method'] == 'POST'), isEmpty);
      expect(journal.entries, hasLength(64));
    },
  );
  test(
    'manual paths reject traversal, credentials and ambiguous separators',
    () {
      for (final path in [
        'relative',
        '/work/../repo',
        '/work/./repo',
        '/work//repo',
        '/work/repo/',
        '/work\\repo',
        '/work/\nrepo',
      ]) {
        expect(validateCheckoutPath(path), isNotNull, reason: path);
      }
      expect(validateCheckoutPath('/work/repo'), isNull);
    },
  );
}
