import 'package:dsh_remote_mobile/main.dart';
import 'package:dsh_remote_mobile/src/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'adoption_widget_test.dart' show FixtureStore;

void main() {
  testWidgets('state swaps are instant when animations are disabled', (
    tester,
  ) async {
    final store = FixtureStore();
    addTearDown(store.dispose);
    Widget app(Widget home) => MaterialApp(
      theme: harnessTheme(Brightness.light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: home,
    );
    await tester.pumpWidget(app(SignInPage(store: store)));
    await tester.tap(find.text('Create an account'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Create account'), findsOneWidget);
    expect(find.text('Sign in'), findsNothing);
    await tester.pumpWidget(
      app(SessionPage(store: store, instanceId: 'i', sessionId: 'session')),
    );
    await tester.pumpAndSettle();
    expect(find.text('In control'), findsOneWidget);
    store.setStatus('stale');
    await tester.pump();
    await tester.pump();
    expect(find.text('In control'), findsNothing);
    expect(find.text('Take control'), findsOneWidget);
    expect(find.textContaining('Stale'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
