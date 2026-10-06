import 'dart:convert';
import 'dart:math';

typedef JsonMap = Map<String, dynamic>;

JsonMap object(Object? value) => value is Map
    ? value.map((key, value) => MapEntry(key.toString(), value))
    : <String, dynamic>{};

String pretty(Object? value) =>
    const JsonEncoder.withIndent('  ').convert(value);

String newId() {
  final random = Random.secure();
  final bytes = List.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((v) => v.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

class Lease {
  const Lease(
    this.controllerId,
    this.epoch,
    this.expiresAt, {
    this.pending = false,
  });
  factory Lease.fromJson(JsonMap json) => Lease(
    json['controllerId'] as String,
    (json['epoch'] as num).toInt(),
    DateTime.fromMillisecondsSinceEpoch((json['expiresAt'] as num).toInt()),
    pending: json['pending'] == true,
  );
  final String controllerId;
  final int epoch;
  final DateTime expiresAt;
  final bool pending;
  bool get expired => !expiresAt.isAfter(DateTime.now());
}

class Instance {
  const Instance({
    required this.id,
    required this.name,
    required this.online,
    required this.lease,
    required this.capabilities,
    String? status,
    this.lastSeenAt,
  }) : status = status ?? (online ? 'online' : 'offline');
  factory Instance.fromJson(JsonMap json) => Instance(
    id: json['id'] as String,
    name: json['name'] as String,
    online: json['status'] == null
        ? json['online'] == true
        : json['status'] == 'online',
    status: json['status']?.toString(),
    lastSeenAt: json['lastSeenAt'] is num
        ? DateTime.fromMillisecondsSinceEpoch(
            (json['lastSeenAt'] as num).toInt(),
          )
        : null,
    lease: json['lease'] is Map ? Lease.fromJson(object(json['lease'])) : null,
    capabilities: (json['capabilities'] as List? ?? [])
        .map((v) => v.toString())
        .toList(),
  );
  final String id;
  final String name;
  final bool online;
  final String status;
  final DateTime? lastSeenAt;
  String get statusLabel => switch (status) {
    'connecting' => 'Connecting',
    'online' => 'Online',
    'stale' => 'Stale · read-only',
    _ => 'Offline',
  };
  final Lease? lease;

  /// Actions the connected plugin version supports, e.g. `workspace.browse`.
  final List<String> capabilities;
  bool heldBy(String? controller) =>
      lease != null && !lease!.expired && lease!.controllerId == controller;
  bool controlledBy(String? controller) =>
      status == 'online' && online && heldBy(controller) && !lease!.pending;
}

class RelayEvent {
  const RelayEvent({
    required this.seq,
    required this.instanceId,
    required this.kind,
    required this.payload,
    required this.createdAt,
  });
  factory RelayEvent.fromJson(JsonMap json) => RelayEvent(
    seq: (json['seq'] as num).toInt(),
    instanceId: json['instanceId'] as String,
    kind: json['kind'] as String,
    payload: json['payload'],
    createdAt: DateTime.fromMillisecondsSinceEpoch(
      (json['createdAt'] as num).toInt(),
    ),
  );
  final int seq;
  final String instanceId;
  final String kind;
  final Object? payload;
  final DateTime createdAt;
}

class RemoteCommand {
  RemoteCommand(this.json);
  final JsonMap json;
  String get id => json['id'].toString();
  String get status => json['status'].toString();
  bool get terminal =>
      ['succeeded', 'failed', 'indeterminate'].contains(status);
  Object? get result => json['result'];
}

const readActions = {
  'session.list',
  'session.read',
  'session.page',
  'session.projections',
  'settings.describe',
  'capabilities',
  'attachment.read',
  'workspace.list',
  'workspace.browse',
};

/// Bind the review display to the same session, call ID, and immutable host event.
/// Text is rendered as plain selectable text, never interpreted as HTML/Markdown.
JsonMap approvalPresentation({
  required JsonMap request,
  required Object? snapshot,
  required List<RelayEvent> events,
  required String instanceId,
  required String sessionId,
}) {
  final callId = request['callId'];
  final candidates = <JsonMap>[
    for (final value in (object(snapshot)['events'] as List? ?? []))
      object(value),
    for (final event in events)
      if (event.instanceId == instanceId &&
          event.kind == 'session.event' &&
          object(event.payload)['sessionId'] == sessionId)
        object(object(event.payload)['data']),
  ];
  JsonMap? call;
  if (callId != null) {
    for (final event in candidates) {
      if (event['type'] == 'tool/call' &&
          object(event['data'])['callId'] == callId &&
          object(event['data'])['name'] == request['toolName']) {
        call = object(event['data']);
      }
    }
  }
  return {
    ...request,
    'toolArgumentsAvailable': callId == null || call?['arguments'] is String,
    'toolArguments':
        call?['arguments'] ??
        (callId == null
            ? 'No tool call ID or arguments were supplied by this request.'
            : 'Arguments are unavailable in the loaded history. Refresh the session and review the exact tool call before allowing it.'),
  };
}

String contentText(Object? content) {
  if (content is String) return content;
  if (content is! List) return '';
  return content
      .map((entry) {
        final block = object(entry);
        return switch (block['type']) {
          'text' || 'reasoning' => block['text']?.toString() ?? '',
          'image' =>
            '[Image${block['name'] == null ? '' : ': ${block['name']}'}]',
          'file' =>
            '[File${block['name'] == null ? '' : ': ${block['name']}'}]',
          'tool-call' || 'tool_use' =>
            '[Tool: ${block['toolName'] ?? block['name'] ?? 'call'}]',
          _ => '',
        };
      })
      .where((value) => value.isNotEmpty)
      .join('\n');
}

List<JsonMap> mergeHistory(Iterable<JsonMap> events) {
  final bySequence = <int, JsonMap>{};
  for (final event in events) {
    final seq = event['seq'];
    if (seq is num) bySequence[seq.toInt()] = event;
  }
  final keys = bySequence.keys.toList()..sort();
  return keys.map((key) => bySequence[key]!).toList();
}

class StreamText {
  StreamText(
    this.attemptId, {
    this.text = '',
    this.lastIndex = -1,
    this.incomplete = false,
  });
  final String attemptId;
  String text;
  int lastIndex;
  bool incomplete;
  void add(JsonMap frame) {
    final index = frame['index'];
    if (index is! num || index <= lastIndex) return;
    incomplete = incomplete || index != lastIndex + 1;
    lastIndex = index.toInt();
    final chunk = object(frame['chunk']);
    if (chunk['type'] == 'text-delta' && chunk['text'] is String) {
      text += chunk['text'] as String;
    }
    if (text.length > 250000) {
      text = text.substring(text.length - 250000);
      incomplete = true;
    }
  }
}

/// Immutable relay reference. Authorization and host observation are independent.
class RepositoryReference {
  RepositoryReference(this.json);
  final JsonMap json;
  String get id => json['id'].toString();
  String get instanceId => json['instanceId'].toString();
  String get fullName => json['fullName']?.toString() ?? 'Repository';
  String get localPath => json['localPath']?.toString() ?? '';
  String get localState => json['localState']?.toString() ?? 'declared';
  String get authorization => json['authorization']?.toString() ?? 'manual';
  bool get selected => json['selected'] == true;
  bool get verified => localState == 'verified';
  JsonMap get contextPreview => {
    'repository': fullName,
    'instanceId': instanceId,
    'branch': json['branch'],
    'head': json['head'],
    'localPath': localPath,
    'localState': localState,
    'verifiedAt': json['verifiedAt'],
    'sourceTrust': 'untrusted_repository_data',
  };
}

String? repositorySelectionError(
  List<RepositoryReference> references,
  String instanceId,
) {
  if (references.length > 8) return 'Choose at most 8 repository references.';
  if (references.map((r) => r.id).toSet().length != references.length) {
    return 'Duplicate repository references are not allowed.';
  }
  if (references.any((r) => r.instanceId != instanceId)) {
    return 'Repository references must belong to this instance.';
  }
  if (references.any((r) => !r.verified)) {
    return 'Verify stale or declared references, or remove them before sending.';
  }
  return null;
}
