import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter/scheduler.dart';

import 'api.dart';
import 'credentials.dart';
import 'host_path.dart';
import 'models.dart';

/// What connecting does for the instance a page shows, as in remote-desktop
/// clients: a free instance is controlled at once ([acquire]), a lease this
/// controller still holds after a reconnect is renewed ([resume]), and
/// another device's control is only taken after asking ([prompt]).
enum AutoControl { acquire, resume, prompt }

const anotherDevice = 'Another device';

class RemoteStore extends ChangeNotifier with WidgetsBindingObserver {
  RemoteStore({
    this.credentials = const SecureCredentialStore(),
    this.journal = const SecureCommandJournalStore(),
  }) {
    WidgetsBinding.instance.addObserver(this);
  }
  final CredentialStore credentials;
  final CommandJournalStore journal;
  String? journalError;
  Future<void> _journalChain = Future<void>.value();
  Future<T> _withJournal<T>(Future<T> Function() operation) {
    final previous = _journalChain;
    final done = Completer<void>();
    _journalChain = done.future;
    return (() async {
      await previous;
      try {
        return await operation();
      } finally {
        done.complete();
      }
    })();
  }

  Future<void> restoreCommandJournal() async {
    final client = api;
    final account = user?['id'];
    if (client == null || account == null) return;
    try {
      final entries = await _withJournal(journal.readJournal);
      if (client != api || user?['id'] != account) return;
      for (final entry in entries) {
        if (entry['server'] == server && entry['userId'] == account) {
          commands.putIfAbsent(
            entry['id'] as String,
            () => RemoteCommand({
              ...entry,
              'status': 'indeterminate',
              'restored': true,
              'submittedBodyUnavailable': true,
              'clientNote':
                  'Restored unresolved operation. Query its original ID. No payload was persisted, so retry is unavailable.',
            }),
          );
        }
      }
      journalError = null;
    } catch (_) {
      if (client == api) {
        journalError =
            'Cannot read the secure command journal. Writes are disabled. Unlock this device, then reload the journal in Command history.';
      }
    }
    _notify();
  }

  Future<void> _journalBeforeDispatch(JsonMap entry) => _withJournal(() async {
    try {
      final entries = await journal.readJournal();
      if (entries.length >= 64) throw StateError('Journal full');
      await journal.saveJournal([...entries, entry]);
    } catch (_) {
      journalError =
          'The command was not sent because its recovery ID could not be saved securely. Unlock the device and reload the command journal.';
      _notify();
      throw ApiException('journal_unavailable', journalError!);
    }
  });
  Future<void> _settleJournal(RemoteCommand command) async {
    if (!['succeeded', 'failed'].contains(command.status) ||
        readActions.contains(command.json['action'])) {
      return;
    }
    final account = user?['id'];
    final origin = server;
    try {
      await _withJournal(() async {
        final entries = await journal.readJournal();
        await journal.saveJournal(
          entries
              .where(
                (entry) =>
                    !(entry['server'] == origin &&
                        entry['userId'] == account &&
                        entry['id'] == command.id),
              )
              .toList(),
        );
      });
    } catch (_) {
      journalError =
          'This result is confirmed, but its secure recovery journal could not be updated. Unlock this device and query it again.';
      _notify();
    }
  }

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
  final Set<String> _abandonedCommands = {};
  final Set<String> _suppressedLeases = {};
  final Map<String, int> _controlEpochs = {};
  final Map<String, List<RepositoryReference>> repositories = {};
  final Map<String, JsonMap> drafts = {};
  JsonMap? githubStatus;

  /// Each instance's path style as its `workspace.list` reported it (or, for
  /// hosts that predate `style`, as its folders show it).
  final Map<String, HostPathStyle> hostStyles = {};

  /// The path style of [id]'s host: as last reported, else as the checkout
  /// paths recorded for it show. Null when nothing is known yet.
  HostPathStyle? hostStyle(String id) =>
      hostStyles[id] ??
      inferHostPathStyle([
        for (final reference in repositories[id] ?? <RepositoryReference>[])
          reference.localPath,
      ]);

  bool canWrite(String id) =>
      journalError == null &&
      connection == 'Live' &&
      !_suppressedLeases.contains(id) &&
      instance(id)?.controlledBy(controllerId) == true;
  bool hasUnresolvedWrite(String id) => commands.values.any(
    (command) =>
        command.json['instanceId'] == id &&
        !readActions.contains(command.json['action']) &&
        !['succeeded', 'failed'].contains(command.status),
  );
  void stopWaiting(String instanceId) {
    for (final command in commands.values.toList()) {
      if (command.json['instanceId'] == instanceId && !command.terminal) {
        _abandonedCommands.add(command.id);
        commands[command.id] = RemoteCommand({
          ...command.json,
          'status': 'indeterminate',
          'clientNote':
              'Stopped waiting. Query the original command; do not resend.',
        });
      }
    }
    _notify();
  }

  void abandonControl(String id) {
    _controlEpochs[id] = (_controlEpochs[id] ?? 0) + 1;
    _suppressedLeases.add(id);
    _ownedLeases.remove(id);
    _notify();
  }

  /// Instances this app process only watches: control was declined,
  /// released, abandoned or taken by another device. In memory only.
  final Set<String> _watchOnly = {};

  /// The last lease state (see [_leaseState]) each instance was handled in,
  /// automatically or by an explicit choice.
  final Map<String, String> _autoControlled = {};

  /// The takeover of each instance already announced (holder and epoch).
  final Map<String, String> _takenOver = {};

  /// "Work laptop took over control. Watching only." per instance, until it is
  /// dismissed or control comes back.
  final Map<String, String> controlNotices = {};

  /// Counts live event-stream connections; a reconnect starts automatic
  /// control over.
  int _liveGeneration = 0;

  bool isWatchOnly(String id) => _watchOnly.contains(id);

  /// Records an explicit choice to only watch [id] or to ask for control.
  /// Either way the current lease state counts as handled, so no automatic
  /// step follows the choice.
  void setWatchOnly(String id, bool watching) {
    if (watching) {
      _watchOnly.add(id);
    } else {
      _watchOnly.remove(id);
    }
    _autoControlled[id] = _leaseState(id);
    _notify();
  }

  void dismissControlNotice(String id) {
    if (controlNotices.remove(id) != null) _notify();
  }

  String _leaseState(String id) {
    final lease = instance(id)?.lease;
    final active = lease != null && !lease.expired;
    return '$id:${active ? lease.controllerId : ''}:'
        '${active ? lease.epoch : 0}:$_liveGeneration';
  }

  /// The automatic control step for [id] while a page shows it, or null.
  ///
  /// Only in the foreground, on a live stream, for an online instance that is
  /// not watch-only and not already controlled here. Each lease state
  /// (instance, holder, epoch) of a live connection yields at most one step,
  /// so a failure cannot loop; a reconnect starts over.
  AutoControl? autoControlStep(String id) {
    final current = instance(id);
    if (current == null ||
        !_foreground ||
        connection != 'Live' ||
        journalError != null ||
        !current.online ||
        _watchOnly.contains(id) ||
        canWrite(id)) {
      return null;
    }
    final lease = current.lease;
    final active = lease != null && !lease.expired;
    final mine = active && lease.controllerId == controllerId;
    // This controller's acquisition is still waiting for the Host's fence.
    if (mine && lease.pending) return null;
    final state = _leaseState(id);
    if (_autoControlled[id] == state) return null;
    _autoControlled[id] = state;
    return mine
        ? AutoControl.resume
        : active
        ? AutoControl.prompt
        : AutoControl.acquire;
  }

  String? _knownName(String? id) {
    for (final entry in controllers) {
      if (entry['id'] == id) {
        final name = entry['name']?.toString().trim() ?? '';
        return name.isEmpty ? null : name;
      }
    }
    return null;
  }

  Future<void> refreshControllers() async {
    final client = api;
    if (client == null) return;
    try {
      final result = await client.request('GET', 'api/controllers');
      if (client != api) return;
      controllers = (result['controllers'] as List? ?? []).map(object).toList();
      _notify();
    } catch (_) {
      // The name falls back to "Another device".
    }
  }

  /// The name of controller [id]. A device that signed in after the list
  /// loaded is looked up again before falling back to "Another device".
  Future<String> controllerName(String? id) async {
    if (id == null) return anotherDevice;
    if (_knownName(id) == null) await refreshControllers();
    return _knownName(id) ?? anotherDevice;
  }

  /// Replaces the instance list and notices control this controller held
  /// passing to another device.
  void _setInstances(List<Instance> next) {
    final before = {for (final entry in instances) entry.id: entry};
    instances = next;
    final me = controllerId;
    if (me == null) return;
    for (final current in next) {
      final lease = current.lease;
      if (before[current.id]?.heldBy(me) != true ||
          lease == null ||
          lease.expired ||
          lease.controllerId == me) {
        continue;
      }
      final takeover = '${lease.controllerId}:${lease.epoch}';
      if (_takenOver[current.id] == takeover) continue;
      _takenOver[current.id] = takeover;
      // Never take it straight back: two devices would push each other off
      // forever. Watching continues until the person asks for control.
      _watchOnly.add(current.id);
      unawaited(_announceTakeover(current.id, lease.controllerId));
    }
  }

  Future<void> _announceTakeover(String id, String holder) async {
    final client = api;
    final name = await controllerName(holder);
    if (client != api || instance(id)?.lease?.controllerId != holder) return;
    controlNotices[id] = '$name took over control. Watching only.';
    _notify();
  }

  String? error;
  String connection = 'Disconnected';
  bool busy = false;
  bool _disposed = false;
  bool _foreground = true;
  bool _connecting = false;
  bool _refreshing = false;
  bool _renewing = false;
  int _authEpoch = 0;
  RelayApi? _authCandidate;
  Future<void> _credentialChain = Future<void>.value();
  Future<T> _withCredentials<T>(Future<T> Function() operation) {
    final previous = _credentialChain;
    final done = Completer<void>();
    _credentialChain = done.future;
    return (() async {
      await previous;
      try {
        return await operation();
      } finally {
        done.complete();
      }
    })();
  }

  void cancelAuthentication() {
    _authEpoch++;
    _authCandidate?.close();
    _authCandidate = null;
    busy = false;
    error = 'Sign-in cancelled. Your fields are retained; retry when ready.';
    _notify();
  }

  void _dropWriteAuthority() {
    _suppressedLeases.addAll(
      instances.where((i) => i.heldBy(controllerId)).map((i) => i.id),
    );
    _ownedLeases.clear();
  }

  void _reconcileControl() {
    for (final current in instances) {
      if (!current.online && current.heldBy(controllerId)) {
        _suppressedLeases.add(current.id);
        _ownedLeases.remove(current.id);
      }
    }
  }

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
  final _jitter = Random();
  WebSocket? _socket;
  Timer? _reconnect;
  Timer? _maintenance;
  bool get signedIn => api?.token != null && user != null;

  /// Whether the app is in the foreground; nothing is renewed or acquired in
  /// the background.
  bool get foreground => _foreground;
  String? get controllerId => controller?['id']?.toString();
  String get server => api?.base.toString() ?? '';
  bool _notificationScheduled = false;
  void _notify() {
    if (_disposed) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      if (_notificationScheduled) return;
      _notificationScheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _notificationScheduled = false;
        if (!_disposed) notifyListeners();
      });
    } else {
      notifyListeners();
    }
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
    final attempt = ++_authEpoch;
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
      _authCandidate = candidate;
      final result = await candidate
          .request('POST', 'api/auth/${register ? 'register' : 'login'}', {
            'email': email.trim(),
            'password': password,
            'deviceName': deviceName.trim(),
          });
      if (attempt != _authEpoch) {
        throw const ApiException('cancelled', 'Sign-in cancelled.');
      }
      candidate.token = result['token'] as String;
      try {
        await _withCredentials(() async {
          if (attempt != _authEpoch) {
            throw const ApiException('cancelled', 'Sign-in cancelled.');
          }
          await credentials.save(
            server: candidate!.base.toString(),
            token: candidate.token!,
          );
          if (attempt != _authEpoch) {
            await credentials.clear();
            throw const ApiException('cancelled', 'Sign-in cancelled.');
          }
        });
      } catch (_) {
        try {
          await candidate.request('POST', 'api/auth/logout');
        } catch (_) {}
        throw const ApiException(
          'secure_storage_failed',
          'Cannot save the session in device secure storage. Unlock the device and try again.',
        );
      }
      if (attempt != _authEpoch) {
        throw const ApiException('cancelled', 'Sign-in cancelled.');
      }
      api?.close();
      api = candidate;
      user = object(result['user']);
      controller = object(result['controller']);
      await restoreCommandJournal();
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
      if (attempt == _authEpoch) error = e.toString();
    } finally {
      if (_authCandidate == candidate) _authCandidate = null;
      if (attempt == _authEpoch) busy = false;
      _notify();
    }
  }

  Future<void> restore() async {
    if (busy || signedIn) return;
    final attempt = ++_authEpoch;
    busy = true;
    _notify();
    RelayApi? candidate;
    try {
      final saved = await _withCredentials(credentials.read);
      if (saved == null || attempt != _authEpoch) return;
      candidate = RelayApi(
        saved['server'] as String,
        allowInsecureHttp:
            !kReleaseMode && const bool.fromEnvironment('ALLOW_INSECURE_HTTP'),
      );
      _authCandidate = candidate;
      candidate.token = saved['token'] as String;
      final me = await candidate.request('GET', 'api/me');
      if (attempt != _authEpoch) {
        throw const ApiException('cancelled', 'Restoration cancelled.');
      }
      api = candidate;
      user = object(me['user']);
      controller = object(me['controller']);
      await restoreCommandJournal();
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
      if (attempt != _authEpoch) return;
      if (e is ApiException && e.statusCode == 401) {
        await credentials.clear();
        error = 'Your saved session expired. Sign in again.';
      } else {
        error =
            'Could not restore the saved session. Unlock the device and check your connection. You can retry restoration or sign in.';
      }
    } finally {
      if (_authCandidate == candidate) _authCandidate = null;
      if (attempt == _authEpoch) busy = false;
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
      // Controllers first, so a takeover noticed below is announced by name.
      controllers = (results[1]['controllers'] as List? ?? [])
          .map(object)
          .toList();
      _setInstances(
        (results[0]['instances'] as List? ?? [])
            .map((v) => Instance.fromJson(object(v)))
            .toList(),
      );
      _reconcileControl();
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

  /// A chunk of a reply being streamed, from a pushed frame or (older relays)
  /// a stored event: `{sessionId, data}`.
  void _applyStream(String instanceId, JsonMap envelope) {
    final session = envelope['sessionId'];
    if (session is! String) return;
    final payload = object(envelope['data']);
    final key = '$instanceId:$session';
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

  /// Puts a lease the relay reported into the instance list.
  void _setLease(String instanceId, Lease? lease) {
    _setInstances([
      for (final item in instances)
        item.id == instanceId ? item.withLease(lease) : item,
    ]);
    _notify();
  }

  Future<void> _maintain() async {
    if (_renewing || !signedIn) return;
    _renewing = true;
    var stale = false;
    try {
      await _withLeaseLock(() async {
        for (final id in List.of(_ownedLeases)) {
          final current = instance(id);
          if (current?.controlledBy(controllerId) != true ||
              _suppressedLeases.contains(id)) {
            _ownedLeases.remove(id);
            continue;
          }
          if (current!.lease!.pending) continue;
          try {
            final lease = await api!.request(
              'POST',
              'api/instances/${Uri.encodeComponent(id)}/lease',
              {'controllerId': controllerId},
            );
            if (lease['controllerId'] is String) {
              _setLease(id, Lease.fromJson(lease));
            } else {
              stale = true;
            }
          } catch (e) {
            _ownedLeases.remove(id);
            error = e.toString();
            stale = true;
          }
        }
        // A live stream reports changes and pushes renewals; every poll is a
        // billed relay request, so poll only without it or after a failure.
        if (stale || connection != 'Live') await refresh();
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
        if (connection != 'Live' || instance(id)?.online != true) {
          throw const ApiException(
            'not_online',
            'Reconnect and refresh online status before acquiring control.',
          );
        }
        final client = api!;
        final epoch = (_controlEpochs[id] ?? 0) + 1;
        _controlEpochs[id] = epoch;
        _suppressedLeases.add(id);
        _ownedLeases.remove(id);
        await client.request(
          'POST',
          'api/instances/${Uri.encodeComponent(id)}/lease',
          {'controllerId': controllerId, 'takeover': takeover},
        );
        final current = await refreshInstance(id);
        if (client == api &&
            _controlEpochs[id] == epoch &&
            connection == 'Live' &&
            current.controlledBy(controllerId)) {
          _suppressedLeases.remove(id);
          _ownedLeases.add(id);
          controlNotices.remove(id);
          _notify();
        }
      });

  Future<void> release(String id) => _withLeaseLock(() async {
    abandonControl(id);
    await api!.request(
      'DELETE',
      'api/instances/${Uri.encodeComponent(id)}/lease',
      {'controllerId': controllerId},
    );
    await refresh();
  });

  Future<Instance> refreshInstance(String id) async {
    final client = api!;
    final result = await client.request(
      'GET',
      'api/instances/${Uri.encodeComponent(id)}/state',
    );
    final value = Instance.fromJson(object(result['instance']));
    if (client == api) {
      _setInstances([
        for (final current in instances)
          if (current.id == id) value else current,
      ]);
      _reconcileControl();
      _notify();
    }
    return value;
  }

  Future<JsonMap> refreshGithub() async {
    final client = api!;
    final value = await client.request('GET', 'api/github/status');
    if (client == api) {
      githubStatus = value;
      _notify();
    }
    return value;
  }

  Future<JsonMap> githubInstallations({int page = 1}) =>
      api!.request('GET', 'api/github/installations?page=$page');
  Future<JsonMap> githubRepositories(
    int installationId, {
    int page = 1,
    int installationPage = 1,
  }) => api!.request(
    'GET',
    'api/github/repositories?installationId=$installationId&page=$page&installationPage=$installationPage',
  );

  /// Where the GitHub App is installed and its repositories chosen.
  Future<String> githubInstallUrl() async {
    final result = await api!.request('POST', 'api/github/install', {
      'controllerId': controllerId,
    });
    final url = result['installationUrl'];
    if (url is! String || Uri.tryParse(url)?.scheme != 'https') {
      throw const ApiException(
        'invalid_response',
        'The relay did not return a GitHub address.',
      );
    }
    return url;
  }

  String? _pluginPackage;

  /// The address of the DSH Remote plugin package this relay serves, from
  /// `/plugin/manifest.json`; null when the relay ships none.
  Future<String?> pluginPackageUrl() async {
    final client = api;
    if (client == null) return null;
    if (_pluginPackage != null) return _pluginPackage;
    try {
      final manifest = await client.request('GET', 'plugin/manifest.json');
      final file = manifest['file'];
      if (file is! String || !RegExp(r'^[\w.-]+\.tgz$').hasMatch(file)) {
        return null;
      }
      final url = client.base.resolve('plugin/$file').toString();
      if (client == api) _pluginPackage = url;
      return url;
    } catch (_) {
      // Without a packed plugin the relay answers with its web app.
      return null;
    }
  }

  Future<void> disconnectGithub() async {
    await api!.request('POST', 'api/github/disconnect', {
      'controllerId': controllerId,
    });
    await refreshGithub();
    for (final id in repositories.keys.toList()) {
      await refreshRepositories(id);
    }
  }

  Future<List<RepositoryReference>> refreshRepositories(String id) async {
    final client = api!;
    final result = await client.request(
      'GET',
      'api/instances/${Uri.encodeComponent(id)}/repositories',
    );
    final values = (result['repositories'] as List? ?? [])
        .map((v) => RepositoryReference(object(v)))
        .toList();
    if (client == api) {
      repositories[id] = values;
      _notify();
    }
    return values;
  }

  Future<RepositoryReference> mapRepository(String id, JsonMap mapping) async {
    final result = await api!.request(
      'POST',
      'api/instances/${Uri.encodeComponent(id)}/repositories',
      {...mapping, 'controllerId': controllerId},
    );
    await refreshRepositories(id);
    return RepositoryReference(object(result['repository']));
  }

  Future<void> selectRepository(
    String id,
    String referenceId,
    bool selected,
  ) async {
    await api!.request(
      'POST',
      'api/instances/${Uri.encodeComponent(id)}/repositories/${Uri.encodeComponent(referenceId)}/select',
      {'controllerId': controllerId, 'selected': selected},
    );
    await refreshRepositories(id);
  }

  Future<void> inspectRepository(String id, String referenceId) async {
    try {
      await command(id, 'repository.inspect', {}, repositoryId: referenceId);
    } finally {
      if (signedIn) await refreshRepositories(id);
    }
  }

  Future<Object?> command(
    String instanceId,
    String action,
    JsonMap args, {
    String? repositoryId,
    List<String>? repositoryIds,
  }) async {
    final client = api;
    if (client == null) {
      throw const ApiException('not_signed_in', 'Sign in first.');
    }
    final write = !readActions.contains(action);
    final controlEpoch = _controlEpochs[instanceId] ?? 0;
    if (write && hasUnresolvedWrite(instanceId)) {
      throw const ApiException(
        'unresolved_write',
        'Query the original command in command history before sending another write. You can keep viewing or leave this screen.',
      );
    }
    if (args.containsKey('repositoryContext') ||
        (repositoryId != null && action != 'repository.inspect') ||
        (repositoryIds != null && action != 'session.prompt') ||
        (repositoryIds != null &&
            (repositoryIds.length > 8 ||
                repositoryIds.toSet().length != repositoryIds.length))) {
      throw const ApiException(
        'invalid_references',
        'Use up to 8 unique instance repository references. Raw repository context is not accepted.',
      );
    }
    final id = newId();
    JsonMap? submittedBody;
    Future<JsonMap> submit([int? leaseEpoch]) async {
      final body = <String, dynamic>{
        'id': id,
        'controllerId': controllerId,
        'action': action,
        'args': args,
        if (write) 'leaseEpoch': leaseEpoch,
        'repositoryId': ?repositoryId,
        if (repositoryIds != null && repositoryIds.isNotEmpty)
          'repositoryIds': repositoryIds,
      };
      if (write) {
        final origin = server;
        final account = user?['id'];
        await _journalBeforeDispatch({
          'server': origin,
          'userId': account,
          'controllerId': controllerId,
          'instanceId': instanceId,
          'id': id,
          'action': action,
          'createdAt': DateTime.now().millisecondsSinceEpoch,
        });
        if (client != api ||
            account != user?['id'] ||
            !canWrite(instanceId) ||
            (_controlEpochs[instanceId] ?? 0) != controlEpoch) {
          // No POST has been invoked: this exact local cancellation can safely
          // remove its journal entry even if the user signed out meanwhile.
          await _withJournal(() async {
            final entries = await journal.readJournal();
            await journal.saveJournal(
              entries
                  .where(
                    (entry) =>
                        !(entry['id'] == id &&
                            entry['server'] == origin &&
                            entry['userId'] == account),
                  )
                  .toList(),
            );
          });
          throw const ApiException(
            'not_dispatched',
            'Control or login changed before dispatch. The command was not sent.',
          );
        }
      }
      submittedBody = body;
      commands[id] = RemoteCommand({
        ...body,
        'instanceId': instanceId,
        'status': 'submitting',
        'submittedBody': body,
      });
      _notify();
      return client.request(
        'POST',
        'api/instances/${Uri.encodeComponent(instanceId)}/commands',
        body,
      );
    }

    try {
      final JsonMap result;
      if (write) {
        result = await _withLeaseLock(() async {
          if (client != api) {
            throw const ApiException(
              'signed_out',
              'The authenticated session changed.',
            );
          }
          if (!canWrite(instanceId)) {
            throw const ApiException(
              'viewer',
              'The instance must be online with acknowledged control and a live connection. Refresh status, then take control.',
            );
          }
          final current = await refreshInstance(instanceId);
          if (!canWrite(instanceId) || !current.controlledBy(controllerId)) {
            throw const ApiException(
              'viewer',
              'Control or online status changed. Refresh status before sending a write.',
            );
          }
          if (hasUnresolvedWrite(instanceId)) {
            throw const ApiException(
              'unresolved_write',
              'Another write is unresolved. Query its original command first.',
            );
          }
          return submit(current.lease!.epoch);
        });
      } else {
        result = await submit();
      }
      if (client != api) {
        throw const ApiException(
          'signed_out',
          'The authenticated session changed.',
        );
      }
      var command = RemoteCommand({
        ...object(result['command'] ?? result),
        'instanceId': instanceId,
        'submittedBody': submittedBody,
      });
      commands[id] = command;
      _notify();
      final deadline = DateTime.now().add(const Duration(seconds: 60));
      while (!command.terminal && DateTime.now().isBefore(deadline)) {
        if (_abandonedCommands.contains(id)) {
          throw ApiException(
            'indeterminate',
            'Stopped waiting for $id. Query its original result; do not resend.',
          );
        }
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
        command = RemoteCommand({
          ...object(update['command'] ?? update),
          'instanceId': instanceId,
          'submittedBody': submittedBody,
        });
        commands[id] = command;
        _notify();
      }
      if (_abandonedCommands.contains(id)) {
        throw ApiException(
          'indeterminate',
          'Stopped waiting for $id. The original result is in command history; your draft was retained.',
        );
      }
      if (!command.terminal) {
        throw ApiException(
          'pending',
          'Command $id is still pending. Query its original result before retrying.',
        );
      }
      if (command.status == 'indeterminate') {
        throw ApiException(
          'indeterminate',
          'The outcome of $id is unknown. Query the original command and inspect the session.',
        );
      }
      if (command.status == 'failed') {
        final failure = object(command.json['error']);
        throw ApiException(
          failure['code']?.toString() ?? 'command_failed',
          failure['message']?.toString() ?? 'The command failed.',
        );
      }
      await _settleJournal(command);
      return command.result;
    } catch (e) {
      if (submittedBody != null && client == api) {
        final previous = commands[id];
        // A deterministic rejection is not an unknown mutation. A missing status
        // query (404) cannot establish whether a concurrently sent POST landed.
        if (previous?.status == 'submitting' &&
            e is ApiException &&
            e.statusCode != null &&
            e.statusCode! >= 400 &&
            e.statusCode! < 500 &&
            e.statusCode != 408) {
          commands[id] = RemoteCommand({
            ...previous!.json,
            'status': 'failed',
            'error': {'code': e.code, 'message': e.message},
          });
        } else if (previous != null && !previous.terminal) {
          commands[id] = RemoteCommand({
            ...previous.json,
            'status': 'indeterminate',
            'clientNote': e.toString(),
          });
        }
        if (commands[id] != null) await _settleJournal(commands[id]!);
        _notify();
      }
      rethrow;
    }
  }

  Future<void> checkCommand(String id) async {
    final result = await api!.request(
      'GET',
      'api/commands/${Uri.encodeComponent(id)}',
    );
    commands[id] = RemoteCommand({
      ...commands[id]?.json ?? {},
      ...object(result['command'] ?? result),
    });
    _abandonedCommands.remove(id);
    await _settleJournal(commands[id]!);
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
      _liveGeneration++;
      connection = 'Live';
      _notify();
      socket.listen(
        (frame) {
          if (generation != _generation || _disposed) return;
          try {
            final json = object(jsonDecode(frame as String));
            if (json['type'] == 'snapshot') {
              _setInstances(
                (json['instances'] as List? ?? [])
                    .map((v) => Instance.fromJson(object(v)))
                    .toList(),
              );
              pendingApprovals.clear();
              streams.clear();
              for (final raw in (json['pendingApprovals'] as List? ?? [])) {
                final request = object(raw);
                if (request['approvalId'] != null) {
                  pendingApprovals[request['approvalId'].toString()] = request;
                }
              }
              _reconcileControl();
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
            // Lease renewals are pushed, not stored as events (no sequence).
            if (json['type'] == 'lease' && json['instanceId'] is String) {
              _setLease(
                json['instanceId'] as String,
                json['lease'] is Map
                    ? Lease.fromJson(object(json['lease']))
                    : null,
              );
              return;
            }
            // Streamed reply chunks are pushed, never stored (no sequence).
            if (json['type'] == 'stream' && json['instanceId'] is String) {
              _applyStream(
                json['instanceId'] as String,
                object(json['payload']),
              );
              _notify();
              return;
            }
            if (json['type'] != 'event') return;
            final event = RelayEvent.fromJson(json);
            if (event.seq <= _after) return;
            _after = event.seq;
            events.add(event);
            final payload = object(object(event.payload)['data']);
            if (event.kind == 'assistant.stream') {
              _applyStream(event.instanceId, object(event.payload));
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
    _dropWriteAuthority();
    connection = _foreground ? 'Reconnecting' : 'Paused';
    _notify();
    if (!_foreground || !signedIn) return;
    _reconnect?.cancel();
    // Exponential backoff (1–32 s) with jitter so a relay restart is not met by every client at once.
    final delay = Duration(
      milliseconds:
          1000 * (1 << (_retries++).clamp(0, 5)) + _jitter.nextInt(400),
    );
    _reconnect = Timer(delay, () => unawaited(_connect()));
  }

  /// Skips the backoff wait, e.g. when the user refreshes while reconnecting.
  void retryNow() {
    if (_socket != null || _connecting || !_foreground || !signedIn) return;
    _reconnect?.cancel();
    _retries = 0;
    unawaited(_connect());
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
      _dropWriteAuthority();
      // Never renew or acquire in the background. On resume the stream
      // reconnects, and the page showing an instance then takes control again
      // (see autoControlStep): it renews a lease that is still ours, or
      // acquires a free one unless the instance is watch-only. Another
      // device's control is only taken after asking.
      _notify();
    }
  }

  Future<void> signOut({bool revoke = true}) async {
    _authEpoch++;
    _authCandidate?.close();
    _authCandidate = null;
    final client = api;
    try {
      await _withCredentials(credentials.clear);
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
    _suppressedLeases.clear();
    _controlEpochs.clear();
    _watchOnly.clear();
    _autoControlled.clear();
    _takenOver.clear();
    controlNotices.clear();
    _abandonedCommands.clear();
    repositories.clear();
    drafts.clear();
    githubStatus = null;
    hostStyles.clear();
    _pluginPackage = null;
    journalError = null;
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
