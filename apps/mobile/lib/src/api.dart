import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'models.dart';

class ApiException implements Exception {
  const ApiException(this.code, this.message, [this.statusCode]);
  final String code;
  final String message;
  final int? statusCode;
  @override
  String toString() => message;
}

/// Native transport. The token never goes into URL query strings or disk storage.
class RelayApi {
  RelayApi(String server, {this.allowInsecureHttp = false})
    : base = validateServer(server, allowInsecureHttp: allowInsecureHttp);
  final Uri base;
  final bool allowInsecureHttp;
  final HttpClient _http = HttpClient()
    ..connectionTimeout = const Duration(seconds: 12);
  String? token;
  bool _closed = false;

  static Uri validateServer(String server, {bool allowInsecureHttp = false}) {
    final uri = Uri.tryParse(server.trim());
    if (uri == null ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        !['http', 'https'].contains(uri.scheme)) {
      throw const ApiException(
        'invalid_server',
        'Enter a valid HTTPS server URL without credentials, query, or fragment.',
      );
    }
    const loopbacks = {'localhost', '127.0.0.1', '::1', '10.0.2.2'};
    if (uri.scheme != 'https' &&
        !loopbacks.contains(uri.host) &&
        !allowInsecureHttp) {
      throw const ApiException(
        'insecure_server',
        'Use HTTPS for remote servers. HTTP is allowed only for local development.',
      );
    }
    return uri.replace(
      path: uri.path.endsWith('/') ? uri.path : '${uri.path}/',
    );
  }

  Future<JsonMap> request(String method, String path, [JsonMap? body]) async {
    if (_closed) {
      throw const ApiException(
        'closed',
        'This connection has been closed. Sign in again.',
      );
    }
    try {
      final request = await _http
          .openUrl(method, base.resolve(path))
          .timeout(const Duration(seconds: 15));
      request.followRedirects = false;
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (token != null) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      }
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close().timeout(
        const Duration(seconds: 20),
      );
      final text = await utf8.decoder
          .bind(response)
          .join()
          .timeout(const Duration(seconds: 20));
      Object? parsed;
      try {
        parsed = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
      } on FormatException {
        throw ApiException(
          'invalid_response',
          'The server returned an invalid response (${response.statusCode}).',
          response.statusCode,
        );
      }
      final json = object(parsed);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final error = object(json['error']);
        throw ApiException(
          error['code']?.toString() ?? 'http_error',
          error['message']?.toString() ??
              'Request failed (${response.statusCode}).',
          response.statusCode,
        );
      }
      return json;
    } on SocketException {
      throw const ApiException(
        'connection_failed',
        'Cannot reach the relay. Check the address and network connection.',
      );
    } on HandshakeException {
      throw const ApiException(
        'tls_failed',
        'The server certificate could not be verified.',
      );
    } on TimeoutException {
      throw const ApiException(
        'timeout',
        'The relay did not respond in time. Check command history before retrying a write.',
      );
    }
  }

  Future<WebSocket> connectEvents(int after) async {
    final uri = base
        .resolve('ws/events')
        .replace(
          scheme: base.scheme == 'https' ? 'wss' : 'ws',
          queryParameters: {'after': '$after'},
        );
    final socket = await WebSocket.connect(
      uri.toString(),
      headers: {HttpHeaders.authorizationHeader: 'Bearer $token'},
    ).timeout(const Duration(seconds: 15));
    socket.pingInterval = const Duration(seconds: 15);
    return socket;
  }

  void close() {
    _closed = true;
    token = null;
    _http.close(force: true);
  }
}
