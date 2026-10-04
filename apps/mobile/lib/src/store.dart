import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'api.dart';
import 'credentials.dart';
import 'models.dart';

class RemoteStore extends ChangeNotifier with WidgetsBindingObserver {
  RemoteStore({this.credentials = const SecureCredentialStore()}) {
    WidgetsBinding.instance.addObserver(this);
  }
  final CredentialStore credentials;
  RelayApi? api;
  JsonMap? user;
  JsonMap? controller;
  List<Instance> instances = [];
  List<JsonMap> controllers = [];
  final List<RelayEvent> events = [];
  final Map<String, RemoteCommand> commands = {};
  final Map<String, JsonMap> pendingApprovals = {};
  final Map<String, StreamText> streams = {};
  final Set<String> _ownedLeases = {};
  String? error;
  String connection = 'Disconnected';
  bool busy = false;
  bool _disposed = false;
  bool _foreground = true;
  bool _connecting = false;
  bool _refreshing = false;
  bool _renewing = false;
  Future<void> _leaseChain = Future<void>.value();
  Future<T> _withLeaseLock<T>(Future<T> Function() operation) {
    final previous = _leaseChain;
    final done = Completer<void>();
    _leaseChain = done.future;
    return (() async {
      await previous;
      try {
        return await operation();
      } finally {
        done.complete();
      }
    })();
  }

  int _generation = 0;
  int _after = 0;
  int _retries = 0;
  WebSocket? _socket;
  Timer? _reconnect;
  Timer? _maintenance;
  bool get signedIn => api?.token != null && user != null;
  String? get controllerId => controller?['id']?.toString();
  String get server => api?.base.toString() ?? '';
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Instance? instance(String id) {
    for (final entry in instances) {
      if (entry.id == id) return entry;
    }
    return null;
  }

  Future<void> authenticate({
    required String server,
    required String email,
    required String password,
    required String deviceName,
    required bool register,
  }) async {
    if (busy) return;
    busy = true;
    error = null;
    _notify();
    RelayApi? candidate;
    try {
      candidate = RelayApi(
        server,
        allowInsecureHttp:
            !kReleaseMode && const bool.fromEnvironment('ALLOW_INSECURE_HTTP'),
      );
      final result = await candidate
          .request('POST', 'api/auth/${register ? 'register' : 'login'}', {
            'email': email.trim(),
            'password': password,
            'deviceName': deviceName.trim(),
          });
      candidate.token = result['token'] as String;
      try {
        await credentials.save(
          server: candidate.base.toString(),
          token: candidate.token!,
        );
      } catch (_) {
        try {
          await candidate.request('POST', 'api/auth/logout');
        } catch (_) {}
        throw const ApiException(
          'secure_storage_failed',
          'Cannot save the session in device secure storage. Unlock the device and try again.',
        );
      }
      api?.close();
      api = candidate;
      user = object(result['user']);
      controller = object(result['controller']);
      _generation++;
      _after = 0;
      await refresh();
      unawaited(_connect());
      _maintenance?.cancel();
      _maintenance = Timer.periodic(const Duration(seconds: 10), (_) {
        if (_foreground) {
          unawaited(_maintain());
        }
      });
    } catch (e) {
      if (api != candidate) candidate?.close();
      error = e.toString();
    } finally {
      busy = false;
      _notify();
    }
  }

  Future<void> restore() async {
    if (busy || signedIn) return;
    busy = true;
    _notify();
    RelayApi? candidate;
    try {
      final saved = await credentials.read();
      if (saved == null) return;
      candidate = RelayApi(
        saved['server'] as String,
        allowInsecureHttp:
            !kReleaseMode && const bool.fromEnvironment('ALLOW_INSECURE_HTTP'),
      );
      candidate.token = saved['token'] as String;
      final me = await candidate.request('GET', 'api/me');
      api = candidate;
      user = object(me['user']);
      controller = object(me['controller']);
      _generation++;
      await refresh();
      _ownedLeases.addAll(
        instances
            .where((entry) => entry.heldBy(controllerId))
            .map((entry) => entry.id),
      );
      unawaited(_connect());
      _maintenance?.cancel();
      _maintenance = Timer.periodic(const Duration(seconds: 10), (_) {
        if (_foreground) unawaited(_maintain());
      });
    } catch (e) {
      if (candidate != api) candidate?.close();
      if (e is ApiException && e.statusCode == 401) {
        await credentials.clear();
        error = 'Your saved session expired. Sign in again.';
      } else {
        error =
            'Could not restore the saved session. Unlock the device and check your connection. You can retry restoration or sign in.';
      }
    } finally {
      busy = false;
      _notify();
    }
  }

  Future<void> refresh() async {
    final client = api;
    if (client == null || _refreshing) return;
    final generation = _generation;
    _refreshing = true;
    try {
      final results = await Future.wait([
        client.request('GET', 'api/instances'),
        client.request('GET', 'api/controllers'),
      ]);
      if (generation != _generation) return;
      instances = (results[0]['instances'] as List? ?? [])
          .map((v) => Instance.fromJson(object(v)))
          .toList();
      controllers = (results[1]['controllers'] as List? ?? [])
          .map(object)
          .toList();
      _ownedLeases.removeWhere(
        (id) => instance(id)?.heldBy(controllerId) != true,
      );
      error = null;
    } catch (e) {
      if (generation == _generation) {
        error = e.toString();
        if (e is ApiException && e.statusCode == 401) {
          await signOut(revoke: false);
        }
      }
    } finally {
      _refreshing = false;
      _notify();
    }
  }

  Future<void> _maintain() async {
    if (_renewing || !signedIn) return;
    _renewing = true;
    try {
      await _withLeaseLock(() async {
        for (final id in List.of(_ownedLeases)) {
          final current = instance(id);
          if (current?.heldBy(controllerId) != true) {
            _ownedLeases.remove(id);
            continue;
          }
          if (current!.lease!.pending) continue;
          try {
            await api!.request(
              'POST',
              'api/instances/${Uri.encodeComponent(id)}/lease',
              {'controllerId': controllerId},
            );
          } catch (e) {
            _ownedLeases.remove(id);
            error = e.toString();
          }
        }
        await refresh();
      });
    } finally {
      _renewing = false;
      _notify();
    }
  }

  Future<JsonMap> createInstance(String name) async {
    final result = await api!.request('POST', 'api/instances', {
      'name': name.trim(),
    });
    await refresh();
    return result;
  }

  Future<void> acquire(String id, {bool takeover = false}) =>
      _withLeaseLock(() async {
        await api!.request(
          'POST',
          'api/instances/${Uri.encodeComponent(id)}/lease',
          {'controllerId': controllerId, 'takeover': takeover},
        );
        _ownedLeases.add(id);
        await refresh();
      });

  Future<void> release(String id) => _withLeaseLock(() async {
    _ownedLeases.remove(id);
    await api!.request(
      'DELETE',
      'api/instances/${Uri.encodeComponent(id)}/lease',
      {'controllerId': controllerId},
    );
    await refresh();
  });

  Future<Object?> command(
    String instanceId,
    String action,
    JsonMap args,
  ) async {
    final client = api;
    if (client == null) {
      throw const ApiException('not_signed_in', 'Sign in first.');
    }
    final write = !readActions.contains(action);
    final id = newId();
    Future<JsonMap> submit([int? leaseEpoch]) => client.request(
      'POST',
      'api/instances/${Uri.encodeComponent(instanceId)}/commands',
      {
        'id': id,
        'controllerId': controllerId,
        'action': action,
        'args': args,
        if (write) 'leaseEpoch': leaseEpoch,
      },
    );
    final JsonMap result;
    if (write) {
      result = await _withLeaseLock(() async {
        if (client != api) {
          throw const ApiException(
            'signed_out',
            'The authenticated session changed.',
          );
        }
        final state = await client.request(
          'GET',
          'api/instances/${Uri.encodeComponent(instanceId)}/state',
        );
        final current = Instance.fromJson(object(state['instance']));
        if (!current.controlledBy(controllerId)) {
          throw const ApiException(
            'viewer',
            'Control is not acknowledged or has changed. Refresh and take control before sending a write command.',
          );
        }
        return submit(current.lease!.epoch);
      });
    } else {
      result = await submit();
    }
    var command = RemoteCommand(object(result['command'] ?? result));
    commands[id] = command;
    _notify();
    final deadline = DateTime.now().add(const Duration(seconds: 60));
    while (!command.terminal && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 750));
      if (client != api) {
        throw const ApiException(
          'signed_out',
          'Session changed while waiting for the command.',
        );
      }
      final update = await client.request(
        'GET',
        'api/commands/${Uri.encodeComponent(id)}',
      );
      command = RemoteCommand(object(update['command'] ?? update));
      commands[id] = command;
      _notify();
    }
    if (!command.terminal) {
      throw ApiException(
        'pending',
        'Command $id is still pending. Check its status before retrying.',
      );
    }
    if (command.status == 'indeterminate') {
      throw ApiException(
        'indeterminate',
        'The outcome of command $id is unknown. Inspect the session before retrying.',
      );
    }
    if (command.status == 'failed') {
      final failure = object(command.json['error']);
      throw ApiException(
        failure['code']?.toString() ?? 'command_failed',
        failure['message']?.toString() ?? 'The command failed.',
      );
    }
    return command.result;
  }

  Future<void> checkCommand(String id) async {
    final result = await api!.request(
      'GET',
      'api/commands/${Uri.encodeComponent(id)}',
    );
    commands[id] = RemoteCommand(object(result['command'] ?? result));
    _notify();
  }

  Future<void> _connect() async {
    if (_connecting || !_foreground || !signedIn || _socket != null) return;
    final generation = _generation;
    _connecting = true;
    connection = _after == 0 ? 'Connecting' : 'Reconnecting';
    _notify();
    try {
      final socket = await api!.connectEvents(_after);
      if (_disposed || generation != _generation || !_foreground) {
        await socket.close();
        return;
      }
      _socket = socket;
      _retries = 0;
      connection = 'Live';
      _notify();
      socket.listen(
        (frame) {
          if (generation != _generation || _disposed) return;
          try {
            final json = object(jsonDecode(frame as String));
            if (json['type'] == 'snapshot') {
              instances = (json['instances'] as List? ?? [])
                  .map((v) => Instance.fromJson(object(v)))
                  .toList();
              pendingApprovals.clear();
              streams.clear();
              for (final raw in (json['pendingApprovals'] as List? ?? [])) {
                final request = object(raw);
                if (request['approvalId'] != null) {
                  pendingApprovals[request['approvalId'].toString()] = request;
                }
              }
              _ownedLeases.removeWhere(
                (id) => instance(id)?.heldBy(controllerId) != true,
              );
              _notify();
              return;
            }
            if (json['type'] == 'reset') {
              _after = 0;
              events.clear();
              pendingApprovals.clear();
              streams.clear();
              _notify();
              return;
            }
            if (json['type'] != 'event') return;
            final event = RelayEvent.fromJson(json);
            if (event.seq <= _after) return;
            _after = event.seq;
            events.add(event);
            final payload = object(object(event.payload)['data']);
            final session = object(event.payload)['sessionId'];
            if (event.kind == 'assistant.stream' && session is String) {
              final key = '${event.instanceId}:$session';
              final attempt = payload['attemptId']?.toString() ?? '';
              if (payload['type'] == 'end') {
                streams.remove(key);
              } else if (payload['type'] == 'start') {
                streams[key] = StreamText(attempt);
              } else if (payload['type'] == 'chunk') {
                if (streams[key]?.attemptId != attempt) {
                  streams[key] = StreamText(attempt, incomplete: true);
                }
                streams[key]!.add(payload);
              }
            }
            if (event.kind == 'instance.offline') {
              streams.removeWhere(
                (key, _) => key.startsWith('${event.instanceId}:'),
              );
            }

            final approvalId = payload['approvalId']?.toString();
            if (approvalId != null && event.kind == 'approval.requested') {
              pendingApprovals[approvalId] = {
                ...payload,
                'instanceId': event.instanceId,
              };
            }
            if (approvalId != null && event.kind == 'approval.settled') {
              pendingApprovals.remove(approvalId);
            }
            if (events.length > 250) events.removeRange(0, events.length - 250);
            // Relay state events refresh leases and online state; output remains losslessly
            // available through session reads, even after the local 250-event window.
            if (event.kind.startsWith('lease.') ||
                event.kind.startsWith('instance.') ||
                event.kind.startsWith('connector.')) {
              unawaited(refresh());
            }
            _notify();
          } catch (_) {
            error =
                'The relay sent an unreadable event. Refresh the session to reconcile.';
            _notify();
          }
        },
        onDone: () => _disconnected(generation),
        onError: (Object e) => _disconnected(generation),
        cancelOnError: true,
      );
      // Resume and reconnect always reconcile current server state.
      unawaited(refresh());
    } catch (_) {
      _disconnected(generation);
    } finally {
      _connecting = false;
    }
  }

  void _disconnected(int generation) {
    if (generation != _generation || _disposed) return;
    _socket = null;
    connection = _foreground ? 'Reconnecting' : 'Paused';
    _notify();
    if (!_foreground || !signedIn) return;
    _reconnect?.cancel();
    final seconds = 1 << (_retries++).clamp(0, 5);
    _reconnect = Timer(Duration(seconds: seconds), () => unawaited(_connect()));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) {
      unawaited(refresh());
      unawaited(_connect());
    } else {
      _reconnect?.cancel();
      _socket?.close();
      _socket = null;
      connection = 'Paused';
      // Do not renew in background or reacquire automatically on resume.
      _notify();
    }
  }

  Future<void> signOut({bool revoke = true}) async {
    final client = api;
    try {
      await credentials.clear();
    } catch (_) {
      error =
          'The local secure session could not be deleted. Unlock this device and sign out again.';
      _notify();
      return;
    }
    _generation++;
    _reconnect?.cancel();
    _maintenance?.cancel();
    await _socket?.close();
    _socket = null;
    _ownedLeases.clear();
    api = null;
    user = null;
    controller = null;
    instances = [];
    controllers = [];
    events.clear();
    commands.clear();
    pendingApprovals.clear();
    streams.clear();
    connection = 'Disconnected';
    _notify();
    if (revoke && client != null) {
      try {
        await client.request('POST', 'api/auth/logout');
      } catch (_) {
        /* Local token is still discarded. */
      }
    }
    client?.close();
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _reconnect?.cancel();
    _maintenance?.cancel();
    _socket?.close();
    api?.close();
    super.dispose();
  }
}
