import 'package:flutter/material.dart';

/// Native adaptation of pinned DSH 5badb150 ui-theme semantic tokens.
/// The system font preserves platform/CJK accessibility; no network font load.
ThemeData harnessTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final ink = dark ? const Color(0xfff9fafb) : const Color(0xff0f1115);
  final surface = dark ? const Color(0xff2c2c2e) : Colors.white;
  final background = dark ? const Color(0xff151517) : Colors.white;
  final selector = dark ? const Color(0xff353638) : const Color(0xfff5f6f7);
  final secondary = dark ? const Color(0xffadb2b8) : const Color(0xff61666b);
  final blue = dark ? const Color(0xff7aaaff) : const Color(0xff4176e6);
  final outline = dark ? const Color(0x29ffffff) : const Color(0x1f000000);
  final scheme = ColorScheme.fromSeed(seedColor: blue, brightness: brightness)
      .copyWith(
        primary: blue,
        secondary: blue,
        secondaryContainer: selector,
        onSecondaryContainer: ink,
        onPrimary: dark ? const Color(0xff151517) : Colors.white,
        surface: surface,
        onSurface: ink,
        onSurfaceVariant: secondary,
        surfaceContainerHighest: selector,
        surfaceContainerLow: selector,
        outline: outline,
        outlineVariant: outline,
      );
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: brightness,
  );
  TextStyle weight(TextStyle? value) =>
      (value ?? const TextStyle()).copyWith(fontWeight: FontWeight.w500);
  return base.copyWith(
    scaffoldBackgroundColor: background,
    textTheme: base.textTheme.copyWith(
      headlineMedium: weight(base.textTheme.headlineMedium),
      titleLarge: weight(base.textTheme.titleLarge),
      titleMedium: weight(base.textTheme.titleMedium),
      titleSmall: weight(base.textTheme.titleSmall),
      labelLarge: weight(base.textTheme.labelLarge),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: background,
      foregroundColor: ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      toolbarHeight: 62,
      titleTextStyle: base.textTheme.titleMedium?.copyWith(
        color: ink,
        fontSize: 15,
        fontWeight: FontWeight.w500,
      ),
      shape: Border(bottom: BorderSide(color: outline, width: .5)),
    ),
    cardTheme: CardThemeData(
      color: surface,
      elevation: 0,
      margin: const EdgeInsets.symmetric(vertical: 6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: outline, width: .5),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
    ),
    drawerTheme: DrawerThemeData(
      backgroundColor: dark ? const Color(0xff232324) : const Color(0xfff9fafb),
      width: 290,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: selector,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: outline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: outline),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: ink,
        foregroundColor: background,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        minimumSize: const Size(44, 44),
        textStyle: base.textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w500,
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: ink,
        side: BorderSide(color: outline),
        minimumSize: const Size(44, 44),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    dividerTheme: DividerThemeData(color: outline, thickness: .5),
  );
}
