import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_remote_mobile/main.dart';

void main() {
  testWidgets('signed-out app presents real server connection form', (
    tester,
  ) async {
    await tester.pumpWidget(const DshRemoteApp(restoreSession: false));
    expect(find.text('Sign in to your relay'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Relay server'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    await tester.ensureVisible(find.text('Create an account'));
    await tester.tap(find.text('Create an account'));
    await tester.pumpAndSettle();
    expect(find.text('Create a relay account'), findsOneWidget);
    expect(find.text('Create account'), findsOneWidget);
    expect(find.text('Already have an account? Sign in'), findsOneWidget);
  });
}
