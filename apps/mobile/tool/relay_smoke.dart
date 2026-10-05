// Real network smoke test against an isolated, registration-enabled relay.
// Creates test users, controller records, and one offline instance. No DSH adapter
// is substituted or simulated; DSH actions require a separately running host.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote_mobile/src/api.dart';
import 'package:dsh_remote_mobile/src/models.dart';

void check(bool value, String label) {
  if (!value) throw StateError(label);
  stdout.writeln('PASS $label');
}

Future<void> main(List<String> arguments) async {
  final url = arguments.isEmpty ? 'http://127.0.0.1:8787' : arguments.single;
  final owner = RelayApi(url);
  final viewer = RelayApi(url);
  final stranger = RelayApi(url);
  final email = 'flutter-${newId()}@example.test';
  final password = 'Test-only-${newId()}';
  try {
    final account = await owner.request('POST', 'api/auth/register', {
      'email': email,
      'password': password,
      'deviceName': 'Flutter smoke owner',
    });
    owner.token = account['token'] as String;
    check(owner.token!.isNotEmpty, 'register issues bearer token');
    final login = await viewer.request('POST', 'api/auth/login', {
      'email': email,
      'password': password,
      'deviceName': 'Flutter smoke viewer',
    });
    viewer.token = login['token'] as String;
    check(
      object(account['controller'])['id'] != object(login['controller'])['id'],
      'separate controller identities',
    );
    final other = await stranger.request('POST', 'api/auth/register', {
      'email': 'flutter-${newId()}@example.test',
      'password': password,
      'deviceName': 'Flutter smoke other tenant',
    });
    stranger.token = other['token'] as String;
    final created = await owner.request('POST', 'api/instances', {
      'name': 'Flutter native transport smoke',
    });
    final instance = Instance.fromJson(object(created['instance']));
    check(
      created['connectorToken'] is String && !instance.online,
      'instance created offline with one-time connector token',
    );
    final fleet = await viewer.request('GET', 'api/instances');
    check(
      (fleet['instances'] as List).any(
        (value) => object(value)['id'] == instance.id,
      ),
      'same account controller can view fleet',
    );
    final otherFleet = await stranger.request('GET', 'api/instances');
    check(
      !(otherFleet['instances'] as List).any(
        (value) => object(value)['id'] == instance.id,
      ),
      'other tenant cannot enumerate instance',
    );
    var denied = false;
    try {
      await stranger.request('GET', 'api/instances/${instance.id}/state');
    } on ApiException catch (error) {
      denied = error.statusCode == 404 || error.statusCode == 403;
    }
    check(denied, 'other tenant denied direct instance state');
    final socket = await owner.connectEvents(0);
    final snapshot = await socket
        .map((frame) => object(jsonDecode(frame as String)))
        .firstWhere((frame) => frame['type'] == 'snapshot')
        .timeout(const Duration(seconds: 10));
    check(
      (snapshot['instances'] as List).any(
        (value) => object(value)['id'] == instance.id,
      ),
      'native bearer WebSocket receives authoritative snapshot',
    );
    await socket.close();
    await owner.request('POST', 'api/auth/logout');
    var revoked = false;
    try {
      await owner.request('GET', 'api/me');
    } on ApiException catch (error) {
      revoked = error.statusCode == 401;
    }
    check(revoked, 'logout revokes bearer token');
    stdout.writeln('PASS real relay smoke completed');
  } finally {
    owner.close();
    viewer.close();
    stranger.close();
  }
  exit(0);
}
