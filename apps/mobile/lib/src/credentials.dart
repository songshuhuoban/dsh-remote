import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'models.dart';

/// Injectable boundary for tests and platform integration. The production
/// implementation always uses OS-backed secure storage, never preferences.
abstract interface class CredentialStore {
  Future<JsonMap?> read();
  Future<void> save({required String server, required String token});
  Future<void> clear();
}

class SecureCredentialStore implements CredentialStore {
  const SecureCredentialStore();
  static const _key = 'dsh-remote.session.v1';
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(),
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );
  @override
  Future<JsonMap?> read() async {
    final value = await _storage.read(key: _key);
    return value == null ? null : object(jsonDecode(value));
  }

  @override
  Future<void> save({required String server, required String token}) => _storage
      .write(key: _key, value: jsonEncode({'server': server, 'token': token}));
  @override
  Future<void> clear() => _storage.delete(key: _key);
}
