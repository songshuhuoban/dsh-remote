import 'package:flutter/material.dart';

/// Spacing scale shared by every screen (docs/design/minimal-ui.md §4).
/// Related items sit 8–12 apart, sections 24–32 apart.
abstract final class Space {
  static const double xs = 4;
  static const double s = 8;
  static const double m = 12;
  static const double l = 16;
  static const double xl = 24;
  static const double xxl = 32;
  static const double xxxl = 48;
}

/// The single left edge of every screen.
const pageInset = EdgeInsets.symmetric(horizontal: Space.l);

/// State changes animate 160–220 ms ease-out, and not at all when the
/// platform asks for reduced motion.
const motionCurve = Curves.easeOut;
Duration motion(BuildContext context, [int milliseconds = 200]) =>
    (MediaQuery.maybeDisableAnimationsOf(context) ?? false)
    ? Duration.zero
    : Duration(milliseconds: milliseconds);

/// Content that appears or disappears fades and slides 4 px.
Widget fadeSlide(Widget child, Animation<double> animation) => FadeTransition(
  opacity: animation,
  child: AnimatedBuilder(
    animation: animation,
    builder: (context, child) => Transform.translate(
      offset: Offset(0, 4 * (1 - animation.value)),
      child: child,
    ),
    child: child,
  ),
);

/// Keeps outgoing and incoming children on the left edge while they swap.
Widget leftStack(Widget? current, List<Widget> previous) => Stack(
  alignment: AlignmentDirectional.centerStart,
  children: [...previous, ?current],
);

/// Text button whose label sits exactly on the content edge. The tap target
/// stays at least 48 px.
final edgeAction = TextButton.styleFrom(
  padding: const EdgeInsets.symmetric(vertical: Space.s),
  minimumSize: const Size(0, 40),
);

/// Segment labels have [Space.m] of padding; shift the control so the first
/// label starts on the content edge.
const segmentEdgeOffset = Offset(-Space.m, 0);

/// Semantic colors that Material's [ColorScheme] has no slot for. Values are
/// the DSH Harness `--dsw-alias-*` tokens for each brightness.
@immutable
class HarnessColors extends ThemeExtension<HarnessColors> {
  const HarnessColors({
    required this.fill,
    required this.secondary,
    required this.success,
    required this.warning,
    required this.warningLabel,
    required this.warningSurface,
    required this.idle,
  });
  final Color fill;
  final Color secondary;
  final Color success;
  final Color warning;
  final Color warningLabel;
  final Color warningSurface;
  final Color idle;

  static HarnessColors of(BuildContext context) =>
      Theme.of(context).extension<HarnessColors>()!;

  @override
  HarnessColors copyWith({
    Color? fill,
    Color? secondary,
    Color? success,
    Color? warning,
    Color? warningLabel,
    Color? warningSurface,
    Color? idle,
  }) => HarnessColors(
    fill: fill ?? this.fill,
    secondary: secondary ?? this.secondary,
    success: success ?? this.success,
    warning: warning ?? this.warning,
    warningLabel: warningLabel ?? this.warningLabel,
    warningSurface: warningSurface ?? this.warningSurface,
    idle: idle ?? this.idle,
  );

  @override
  HarnessColors lerp(HarnessColors? other, double t) {
    if (other == null) return this;
    return HarnessColors(
      fill: Color.lerp(fill, other.fill, t)!,
      secondary: Color.lerp(secondary, other.secondary, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningLabel: Color.lerp(warningLabel, other.warningLabel, t)!,
      warningSurface: Color.lerp(warningSurface, other.warningSurface, t)!,
      idle: Color.lerp(idle, other.idle, t)!,
    );
  }
}

/// Native adaptation of pinned DSH 5badb150 ui-theme semantic tokens.
/// The system font preserves platform/CJK accessibility; no network font load.
///
/// No lines: dividers, card and input borders are removed here so every
/// screen groups content with whitespace and type alone. Elevation is kept
/// only for overlays (dialogs, menus, drawers, snackbars).
ThemeData harnessTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final ink = dark ? const Color(0xfff9fafb) : const Color(0xff0f1115);
  final surface = dark ? const Color(0xff2c2c2e) : Colors.white;
  final background = dark ? const Color(0xff151517) : Colors.white;
  final fill = dark ? const Color(0xff353638) : const Color(0xfff5f6f7);
  final secondary = dark ? const Color(0xffadb2b8) : const Color(0xff61666b);
  final tertiary = dark ? const Color(0xff81858c) : const Color(0xffadb2b8);
  final blue = dark ? const Color(0xff7aaaff) : const Color(0xff4176e6);
  final error = dark ? const Color(0xfff25a5a) : const Color(0xffdc2626);
  final colors = HarnessColors(
    fill: fill,
    secondary: secondary,
    success: dark ? const Color(0xff4ed17e) : const Color(0xff22c55e),
    warning: const Color(0xfff59e0b),
    warningLabel: const Color(0xffdd8629),
    warningSurface: dark ? const Color(0xff27241f) : const Color(0xfffef5e7),
    idle: tertiary,
  );
  final scheme = ColorScheme.fromSeed(seedColor: blue, brightness: brightness)
      .copyWith(
        primary: blue,
        secondary: blue,
        secondaryContainer: fill,
        onSecondaryContainer: ink,
        onPrimary: dark ? const Color(0xff151517) : Colors.white,
        surface: surface,
        onSurface: ink,
        onSurfaceVariant: secondary,
        surfaceContainerHighest: fill,
        surfaceContainerHigh: fill,
        surfaceContainer: fill,
        surfaceContainerLow: fill,
        surfaceTint: Colors.transparent,
        error: error,
        errorContainer: dark
            ? Color.alphaBlend(error.withValues(alpha: .16), background)
            : const Color(0xfffee2e2),
        onErrorContainer: dark
            ? const Color(0xfffee2e2)
            : const Color(0xff570c0c),
        outline: dark ? const Color(0x29ffffff) : const Color(0x1f000000),
        outlineVariant: Colors.transparent,
      );
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: brightness,
  );

  // Type scale 12 / 13 / 15 / 20 / 28, weights 400 and 500 only.
  TextStyle type(
    TextStyle? value,
    double size,
    FontWeight weight,
    double height, [
    Color? color,
  ]) => (value ?? const TextStyle()).copyWith(
    fontSize: size,
    fontWeight: weight,
    height: height,
    letterSpacing: 0,
    color: color ?? ink,
  );
  const regular = FontWeight.w400;
  const medium = FontWeight.w500;
  final t = base.textTheme;
  final textTheme = t.copyWith(
    displayLarge: type(t.displayLarge, 28, regular, 1.25),
    displayMedium: type(t.displayMedium, 28, regular, 1.25),
    displaySmall: type(t.displaySmall, 28, regular, 1.25),
    headlineLarge: type(t.headlineLarge, 28, medium, 1.25),
    headlineMedium: type(t.headlineMedium, 28, medium, 1.25),
    headlineSmall: type(t.headlineSmall, 20, medium, 1.3),
    titleLarge: type(t.titleLarge, 20, medium, 1.3),
    titleMedium: type(t.titleMedium, 15, medium, 1.4),
    titleSmall: type(t.titleSmall, 13, medium, 1.4),
    bodyLarge: type(t.bodyLarge, 15, regular, 1.45),
    bodyMedium: type(t.bodyMedium, 15, regular, 1.45),
    bodySmall: type(t.bodySmall, 13, regular, 1.4, secondary),
    labelLarge: type(t.labelLarge, 15, medium, 1.3),
    labelMedium: type(t.labelMedium, 13, medium, 1.3),
    labelSmall: type(t.labelSmall, 12, medium, 1.3),
  );

  final rounded = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(12),
  );
  final noLine = UnderlineInputBorder(
    borderSide: BorderSide.none,
    borderRadius: BorderRadius.circular(12),
  );
  final overlayShadow = Colors.black.withValues(alpha: dark ? .5 : .12);

  return base.copyWith(
    scaffoldBackgroundColor: background,
    canvasColor: background,
    dividerColor: Colors.transparent,
    textTheme: textTheme,
    extensions: [colors],
    appBarTheme: AppBarTheme(
      backgroundColor: background,
      foregroundColor: ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      toolbarHeight: 56,
      titleTextStyle: textTheme.titleMedium,
    ),
    cardTheme: CardThemeData(
      color: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: rounded,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: surface,
      surfaceTintColor: Colors.transparent,
      shadowColor: overlayShadow,
      elevation: 6,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      titleTextStyle: textTheme.titleLarge,
      contentTextStyle: textTheme.bodyMedium,
      actionsPadding: const EdgeInsets.fromLTRB(
        Space.xl,
        0,
        Space.xl,
        Space.xl,
      ),
    ),
    drawerTheme: DrawerThemeData(
      backgroundColor: dark ? const Color(0xff232324) : const Color(0xfff9fafb),
      surfaceTintColor: Colors.transparent,
      shadowColor: overlayShadow,
      width: 290,
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: surface,
      surfaceTintColor: Colors.transparent,
      shadowColor: overlayShadow,
      elevation: 8,
      shape: rounded,
      textStyle: textTheme.bodyMedium,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: ink,
      contentTextStyle: textTheme.bodyMedium?.copyWith(color: background),
      actionTextColor: dark ? const Color(0xff4176e6) : const Color(0xff7aaaff),
      elevation: 6,
      shape: rounded,
    ),
    inputDecorationTheme: InputDecorationThemeData(
      filled: true,
      // Focus and errors tint the fill instead of drawing an outline.
      fillColor: WidgetStateColor.resolveWith(
        (states) => states.contains(WidgetState.error)
            ? Color.alphaBlend(error.withValues(alpha: .08), fill)
            : states.contains(WidgetState.focused)
            ? Color.alphaBlend(blue.withValues(alpha: .10), fill)
            : fill,
      ),
      hoverColor: Colors.transparent,
      border: noLine,
      enabledBorder: noLine,
      focusedBorder: noLine,
      disabledBorder: noLine,
      errorBorder: noLine,
      focusedErrorBorder: noLine,
      contentPadding: const EdgeInsets.fromLTRB(Space.l, 10, Space.l, 10),
      labelStyle: textTheme.bodyMedium?.copyWith(color: secondary),
      floatingLabelStyle: WidgetStateTextStyle.resolveWith(
        (states) => textTheme.bodySmall!.copyWith(
          color: states.contains(WidgetState.error)
              ? error
              : states.contains(WidgetState.focused)
              ? blue
              : secondary,
        ),
      ),
      hintStyle: textTheme.bodyMedium?.copyWith(color: tertiary),
      helperStyle: textTheme.bodySmall,
      errorStyle: textTheme.bodySmall?.copyWith(color: error),
    ),
    textSelectionTheme: TextSelectionThemeData(cursorColor: blue),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: ink,
        foregroundColor: background,
        disabledBackgroundColor: fill,
        disabledForegroundColor: tertiary,
        shape: rounded,
        elevation: 0,
        minimumSize: const Size(44, 44),
        padding: const EdgeInsets.symmetric(horizontal: 20),
        textStyle: textTheme.labelLarge,
      ),
    ),
    // OutlinedButton is the quiet secondary button: a soft fill, no outline.
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: ink,
        backgroundColor: fill,
        disabledForegroundColor: tertiary,
        side: BorderSide.none,
        minimumSize: const Size(44, 44),
        padding: const EdgeInsets.symmetric(horizontal: Space.l),
        shape: rounded,
        textStyle: textTheme.labelLarge,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: blue,
        disabledForegroundColor: tertiary,
        minimumSize: const Size(44, 40),
        padding: const EdgeInsets.symmetric(horizontal: Space.m),
        shape: rounded,
        textStyle: textTheme.labelLarge,
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        foregroundColor: ink,
        disabledForegroundColor: tertiary,
      ),
    ),
    // Segments read as typographic tabs: the selected label is ink and
    // medium weight, the others secondary. No track, fill or outline.
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        side: const WidgetStatePropertyAll(BorderSide.none),
        shape: WidgetStatePropertyAll(rounded),
        visualDensity: VisualDensity.compact,
        textStyle: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? textTheme.labelLarge
              : textTheme.labelLarge?.copyWith(fontWeight: regular),
        ),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: Space.m),
        ),
        backgroundColor: const WidgetStatePropertyAll(Colors.transparent),
        foregroundColor: WidgetStateColor.resolveWith(
          (states) => states.contains(WidgetState.disabled)
              ? tertiary
              : states.contains(WidgetState.selected)
              ? ink
              : secondary,
        ),
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: background,
      side: BorderSide.none,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      labelStyle: textTheme.labelMedium,
      deleteIconColor: secondary,
      padding: const EdgeInsets.symmetric(horizontal: Space.xs),
    ),
    listTileTheme: ListTileThemeData(
      contentPadding: pageInset,
      shape: rounded,
      iconColor: secondary,
      selectedColor: ink,
      selectedTileColor: fill,
      titleTextStyle: textTheme.bodyLarge,
      subtitleTextStyle: textTheme.bodySmall,
      minVerticalPadding: Space.s,
    ),
    expansionTileTheme: ExpansionTileThemeData(
      shape: const Border(),
      collapsedShape: const Border(),
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: Space.m),
      expandedAlignment: Alignment.centerLeft,
      iconColor: secondary,
      collapsedIconColor: secondary,
      textColor: ink,
      collapsedTextColor: ink,
    ),
    checkboxTheme: CheckboxThemeData(
      side: BorderSide(color: secondary, width: 1.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: blue,
      linearTrackColor: Colors.transparent,
      circularTrackColor: Colors.transparent,
      linearMinHeight: 2,
      strokeWidth: 2,
      stopIndicatorColor: Colors.transparent,
    ),
    dividerTheme: const DividerThemeData(
      color: Colors.transparent,
      thickness: 0,
      space: 0,
    ),
  );
}
