// droidpanel network logger for Dio — https://github.com/jubairmoaj/droidpanel
//
// Prints every request/response to logcat as `DPNET|…` lines that the droidpanel
// "Network" tab turns into a request list. Debug builds only:
//
//   import 'package:flutter/foundation.dart';
//   if (kDebugMode) dio.interceptors.add(DroidpanelNetLog());
//
// Add it LAST so it sees the final headers (auth tokens etc.).
import 'dart:convert';

import 'package:dio/dio.dart';

class DroidpanelNetLog extends Interceptor {
  DroidpanelNetLog({this.maxBodyChars = 64 * 1024, this.maskHeaders = const {'authorization', 'cookie', 'set-cookie'}});

  /// Bodies longer than this are truncated.
  final int maxBodyChars;

  /// Header values that are partially masked (last 6 chars kept).
  final Set<String> maskHeaders;

  static const _chunk = 800; // stay far below logcat's ~4 KB line limit
  static int _seq = 0;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final id = '$now-${_seq++}';
    options.extra['dpnet.id'] = id;
    options.extra['dpnet.t'] = now;
    _emit(id, 'start', {
      'method': options.method,
      'url': options.uri.toString(),
      'startedAt': now,
      'reqHeaders': _headers(options.headers.map((k, v) => MapEntry(k, '$v'))),
      'reqBody': _body(options.data),
    });
    handler.next(options);
  }

  @override
  void onResponse(Response<dynamic> response, ResponseInterceptorHandler handler) {
    _end(response.requestOptions, response, null);
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    _end(err.requestOptions, err.response, '${err.type.name}: ${err.message ?? err.error ?? ''}');
    handler.next(err);
  }

  void _end(RequestOptions o, Response<dynamic>? r, String? error) {
    final id = o.extra['dpnet.id'];
    if (id is! String) return;
    final started = o.extra['dpnet.t'] as int? ?? 0;
    _emit(id, 'end', {
      'status': r?.statusCode,
      'durationMs': DateTime.now().millisecondsSinceEpoch - started,
      'resHeaders': r == null ? null : _headers(r.headers.map.map((k, v) => MapEntry(k, v.join(', ')))),
      'resBody': _body(r?.data),
      'error': error,
    });
  }

  Map<String, String> _headers(Map<String, String> h) => h.map((k, v) {
        if (!maskHeaders.contains(k.toLowerCase()) || v.length <= 10) return MapEntry(k, v);
        return MapEntry(k, '…${v.substring(v.length - 6)}');
      });

  String? _body(Object? data) {
    if (data == null) return null;
    String s;
    if (data is FormData) {
      s = jsonEncode({
        'fields': {for (final f in data.fields) f.key: f.value},
        'files': [for (final f in data.files) '${f.key}: ${f.value.filename} (${f.value.length} bytes)'],
      });
    } else if (data is List<int>) {
      s = '<${data.length} bytes>';
    } else if (data is String) {
      s = data;
    } else {
      try {
        s = jsonEncode(data);
      } catch (_) {
        s = data.toString();
      }
    }
    return s.length > maxBodyChars ? '${s.substring(0, maxBodyChars)}…[truncated ${s.length - maxBodyChars} chars]' : s;
  }

  static void _emit(String id, String phase, Map<String, Object?> event) {
    final json = jsonEncode({'id': id, 'phase': phase, ...event});
    final n = (json.length / _chunk).ceil();
    for (var i = 0; i < n; i++) {
      final end = (i + 1) * _chunk;
      // ignore: avoid_print
      print('DPNET|$id.$phase|$i|$n|${json.substring(i * _chunk, end > json.length ? json.length : end)}');
    }
  }
}
