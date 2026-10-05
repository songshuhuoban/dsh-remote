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

/// Only bounded unresolved identifiers are stored here, never prompt/attachment
/// payloads. Native production always uses the same OS-secure storage boundary.
abstract interface class CommandJournalStore {
  Future<List<JsonMap>> readJournal();
  Future<void> saveJournal(List<JsonMap> entries);
}

class SecureCommandJournalStore implements CommandJournalStore {
  const SecureCommandJournalStore();
  static const _key = 'dsh-remote.commands.v1';
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(),
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );
  @override
  Future<List<JsonMap>> readJournal() async {
    final value = await _storage.read(key: _key);
    if (value == null) return [];
    if (value.length > 32768) {
      throw const FormatException('Command journal exceeds its limit');
    }
    final parsed = jsonDecode(value);
    if (parsed is! List || parsed.length > 64 || parsed.any((v) => v is! Map)) {
      throw const FormatException('Invalid command journal');
    }
    final entries = parsed.map(object).toList();
    for (final entry in entries) {
      if ([
        'server',
        'userId',
        'controllerId',
        'instanceId',
        'id',
        'action',
      ].any((key) => entry[key] is! String || (entry[key] as String).isEmpty)) {
        throw const FormatException('Invalid command journal entry');
      }
    }
    return entries;
  }

  @override
  Future<void> saveJournal(List<JsonMap> entries) {
    final value = jsonEncode(entries);
    if (entries.length > 64 || utf8.encode(value).length > 32768) {
      throw StateError(
        'The unresolved-command journal is full. Query existing commands before another write.',
      );
    }
    return _storage.write(key: _key, value: value);
  }
}
