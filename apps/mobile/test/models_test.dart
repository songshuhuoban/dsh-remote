import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_remote_mobile/src/api.dart';
import 'package:dsh_remote_mobile/src/models.dart';

void main() {
  test('remote connections require HTTPS and reject credential URLs', () {
    expect(
      () => RelayApi.validateServer('http://example.com'),
      throwsA(isA<ApiException>()),
    );
    expect(
      () => RelayApi.validateServer('https://user:secret@example.com'),
      throwsA(isA<ApiException>()),
    );
    expect(
      () => RelayApi.validateServer('https://example.com?token=secret'),
      throwsA(isA<ApiException>()),
    );
    expect(
      RelayApi.validateServer('https://example.com/relay').path,
      '/relay/',
    );
    expect(RelayApi.validateServer('http://10.0.2.2:8787').host, '10.0.2.2');
  });
  test('writer lease must match controller, be current, and be online', () {
    final lease = Lease(
      'controller-a',
      9,
      DateTime.now().add(const Duration(seconds: 30)),
    );
    final instance = Instance(
      id: 'i',
      name: 'local',
      online: true,
      lease: lease,
      capabilities: [],
    );
    expect(instance.controlledBy('controller-a'), isTrue);
    expect(instance.controlledBy('controller-b'), isFalse);
    expect(
      Instance(
        id: 'i',
        name: 'local',
        online: false,
        lease: lease,
        capabilities: [],
      ).controlledBy('controller-a'),
      isFalse,
    );
    expect(
      Lease(
        'a',
        1,
        DateTime.now().subtract(const Duration(seconds: 1)),
      ).expired,
      isTrue,
    );
  });
  test('generated command IDs are UUIDv4 and unique', () {
    final values = List.generate(1000, (_) => newId());
    final uuid = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
    expect(values.every(uuid.hasMatch), isTrue);
    expect(values.toSet().length, values.length);
  });
  test('unknown outcomes are terminal and are not silently successful', () {
    expect(RemoteCommand({'status': 'indeterminate'}).terminal, isTrue);
    expect(RemoteCommand({'status': 'dispatched'}).terminal, isFalse);
  });

  test('pending fence retains ownership but disables mutation', () {
    final value = Instance.fromJson({
      'id': 'i',
      'name': 'test',
      'online': true,
      'lease': {
        'controllerId': 'c',
        'epoch': 2,
        'expiresAt': DateTime.now()
            .add(const Duration(seconds: 30))
            .millisecondsSinceEpoch,
        'pending': true,
      },
      'capabilities': [],
    });
    expect(value.heldBy('c'), isTrue);
    expect(value.controlledBy('c'), isFalse);
  });
  test('approval tool details require exact call ID and tool name', () {
    final request = {'callId': 'call', 'toolName': 'write'};
    JsonMap review(List<JsonMap> events) => approvalPresentation(
      request: request,
      snapshot: {'events': events},
      events: [],
      instanceId: 'i',
      sessionId: 's',
    );
    expect(review([])['toolArgumentsAvailable'], isFalse);
    expect(
      review([
        {
          'type': 'tool/call',
          'data': {'callId': 'call', 'name': 'read', 'arguments': '{}'},
        },
      ])['toolArgumentsAvailable'],
      isFalse,
    );
    expect(
      review([
        {
          'type': 'tool/call',
          'data': {
            'callId': 'call',
            'name': 'write',
            'arguments': '{"path":"a"}',
          },
        },
      ])['toolArguments'],
      '{"path":"a"}',
    );
  });
  test('history merge sorts and deduplicates durable sequences', () {
    final history = mergeHistory([
      {'seq': 3, 'type': 'old'},
      {'seq': 1},
      {'seq': 3, 'type': 'new'},
    ]);
    expect(history.map((event) => event['seq']).toList(), [1, 3]);
    expect(history.last['type'], 'new');
    expect(
      contentText([
        {'type': 'text', 'text': 'hello'},
        {'type': 'image'},
      ]),
      'hello\n[Image]',
    );
  });
  test('stream chunks deduplicate and mark missing chunks', () {
    final stream = StreamText('attempt');
    stream.add({
      'index': 0,
      'chunk': {'type': 'text-delta', 'text': 'a'},
    });
    stream.add({
      'index': 0,
      'chunk': {'type': 'text-delta', 'text': 'duplicate'},
    });
    stream.add({
      'index': 2,
      'chunk': {'type': 'text-delta', 'text': 'c'},
    });
    expect(stream.text, 'ac');
    expect(stream.incomplete, isTrue);
  });
}
