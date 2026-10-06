import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'models.dart';
import 'store.dart';
import 'theme.dart';

/// Shows [child] in place, fading and sliding 4 px while it grows in or
/// collapses out. A null child collapses to nothing.
class Reveal extends StatelessWidget {
  const Reveal({this.child, this.padding = EdgeInsets.zero, super.key});
  final Widget? child;
  final EdgeInsetsGeometry padding;
  @override
  Widget build(BuildContext context) {
    final duration = motion(context);
    return AnimatedSwitcher(
      duration: duration,
      switchInCurve: motionCurve,
      switchOutCurve: motionCurve,
      transitionBuilder: (child, animation) => SizeTransition(
        sizeFactor: animation,
        alignment: AlignmentDirectional.topStart,
        child: fadeSlide(child, animation),
      ),
      layoutBuilder: (current, previous) => Stack(
        alignment: AlignmentDirectional.topStart,
        children: [...previous, ?current],
      ),
      child: child == null
          ? const SizedBox(width: double.infinity)
          : Padding(
              key: const ValueKey('revealed'),
              padding: padding,
              child: child,
            ),
    );
  }
}

/// Animates [child]'s size changes. With reduced motion the size simply
/// snaps: AnimatedSize cannot run with a zero duration.
class Resize extends StatelessWidget {
  const Resize({required this.child, super.key});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final duration = motion(context);
    if (duration == Duration.zero) return child;
    return AnimatedSize(
      duration: duration,
      curve: motionCurve,
      alignment: AlignmentDirectional.centerStart,
      child: child,
    );
  }
}

/// Swaps one label (or icon) for another in place.
class Swap extends StatelessWidget {
  const Swap({required this.child, super.key});
  final Widget child;
  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
    duration: motion(context),
    switchInCurve: motionCurve,
    switchOutCurve: motionCurve,
    transitionBuilder: fadeSlide,
    layoutBuilder: leftStack,
    child: child,
  );
}

/// One message box for errors and notices. Errors use [ErrorNotice] so they
/// stay distinguishable from neutral notices.
class Notice extends StatelessWidget {
  const Notice(this.text, {this.error = false, this.onDismiss, super.key});
  final String text;
  final bool error;
  final VoidCallback? onDismiss;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final foreground = error ? scheme.onErrorContainer : scheme.onSurface;
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(
        Space.l,
        onDismiss == null ? Space.m : Space.s,
        onDismiss == null ? Space.l : Space.s,
        onDismiss == null ? Space.m : Space.s,
      ),
      decoration: BoxDecoration(
        color: error ? scheme.errorContainer : HarnessColors.of(context).fill,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Expanded(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 86),
              child: SingleChildScrollView(
                child: Text(
                  text,
                  style: Theme.of(
                    context,
                  ).textTheme.bodyMedium?.copyWith(color: foreground),
                ),
              ),
            ),
          ),
          if (onDismiss != null)
            IconButton(
              tooltip: error ? 'Dismiss error' : 'Dismiss notice',
              onPressed: onDismiss,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints.tightFor(width: 32, height: 32),
              style: IconButton.styleFrom(
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              color: foreground,
              icon: const Icon(Icons.close, size: 18),
            ),
        ],
      ),
    );
  }
}

class ErrorNotice extends StatelessWidget {
  const ErrorNotice(this.text, {this.onDismiss, super.key});
  final String text;
  final VoidCallback? onDismiss;
  @override
  Widget build(BuildContext context) =>
      Notice(text, error: true, onDismiss: onDismiss);
}

/// While [busy], a thin progress bar with the way out at the end of its row.
class BusyBar extends StatelessWidget {
  const BusyBar({required this.busy, required this.onStop, super.key});
  final bool busy;
  final VoidCallback onStop;
  @override
  Widget build(BuildContext context) => Reveal(
    child: busy
        ? Row(
            children: [
              const SizedBox(width: Space.l),
              const Expanded(child: LinearProgressIndicator()),
              const SizedBox(width: Space.s),
              TextButton(onPressed: onStop, child: const Text('Stop waiting')),
              const SizedBox(width: Space.xs),
            ],
          )
        : null,
  );
}

enum Tone { good, pending, idle }

/// A status as one dot and one word.
class StatusDot extends StatelessWidget {
  const StatusDot(this.label, {required this.tone, super.key});

  /// Instance status, with relay transport problems taking precedence:
  /// writes need both, so the user sees one combined state.
  factory StatusDot.instance(RemoteStore store, Instance? instance) =>
      store.connection == 'Live'
      ? StatusDot.forInstance(instance)
      : StatusDot.relay(store.connection);

  factory StatusDot.forInstance(Instance? instance) => StatusDot(
    instance?.statusLabel ?? 'Offline',
    tone: switch (instance?.status) {
      'online' => Tone.good,
      'connecting' || 'stale' => Tone.pending,
      _ => Tone.idle,
    },
  );

  factory StatusDot.relay(String connection) => StatusDot(
    connection,
    tone: switch (connection) {
      'Live' => Tone.good,
      'Connecting' || 'Reconnecting' => Tone.pending,
      _ => Tone.idle,
    },
  );

  final String label;
  final Tone tone;
  @override
  Widget build(BuildContext context) {
    final colors = HarnessColors.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedContainer(
          duration: motion(context),
          curve: motionCurve,
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: switch (tone) {
              Tone.good => colors.success,
              Tone.pending => colors.warning,
              Tone.idle => colors.idle,
            },
          ),
        ),
        const SizedBox(width: 6),
        Flexible(
          child: Swap(
            child: Text(
              label,
              key: ValueKey(label),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ),
      ],
    );
  }
}

enum ControlState { available, takeover, confirming, owned }

/// The writer-lease control as one element:
/// Take control → Confirming… → In control (activating releases).
/// Reads "Take over" when another device holds the lease.
class ControlButton extends StatelessWidget {
  const ControlButton({
    required this.state,
    required this.onPressed,
    super.key,
  });
  final ControlState state;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final colors = HarnessColors.of(context);
    final duration = motion(context);
    final enabled = onPressed != null && state != ControlState.confirming;
    final label = switch (state) {
      ControlState.available => 'Take control',
      ControlState.takeover => 'Take over',
      ControlState.confirming => 'Confirming…',
      ControlState.owned => 'In control',
    };
    final background = !enabled
        ? colors.fill
        : switch (state) {
            ControlState.available => scheme.onSurface,
            ControlState.owned => Color.alphaBlend(
              scheme.primary.withValues(alpha: .12),
              Theme.of(context).scaffoldBackgroundColor,
            ),
            _ => colors.fill,
          };
    final foreground = state == ControlState.confirming
        ? colors.secondary
        : !enabled
        ? colors.idle
        : switch (state) {
            ControlState.available => Theme.of(context).scaffoldBackgroundColor,
            ControlState.owned => scheme.primary,
            _ => scheme.onSurface,
          };
    final Widget? icon = switch (state) {
      ControlState.confirming => SizedBox(
        width: 14,
        height: 14,
        child: CircularProgressIndicator(color: foreground),
      ),
      ControlState.owned => const Icon(Icons.check_rounded, size: 18),
      _ => null,
    };
    return Semantics(
      hint: state == ControlState.owned ? 'Activate to release control' : null,
      child: TweenAnimationBuilder<Color?>(
        tween: ColorTween(end: background),
        duration: duration,
        curve: motionCurve,
        builder: (context, fill, _) => TweenAnimationBuilder<Color?>(
          tween: ColorTween(end: foreground),
          duration: duration,
          curve: motionCurve,
          builder: (context, ink, _) => FilledButton(
            onPressed: enabled ? onPressed : null,
            style: FilledButton.styleFrom(
              backgroundColor: fill,
              disabledBackgroundColor: fill,
              foregroundColor: ink,
              disabledForegroundColor: ink,
              padding: const EdgeInsets.symmetric(horizontal: Space.l),
            ),
            child: Resize(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AnimatedSwitcher(
                    duration: duration,
                    switchInCurve: motionCurve,
                    switchOutCurve: motionCurve,
                    transitionBuilder: (child, animation) => ScaleTransition(
                      scale: Tween(begin: .6, end: 1.0).animate(animation),
                      child: FadeTransition(opacity: animation, child: child),
                    ),
                    child: icon == null
                        ? const SizedBox.shrink()
                        : Padding(
                            key: ValueKey(state),
                            padding: const EdgeInsets.only(right: Space.s),
                            child: icon,
                          ),
                  ),
                  Swap(child: Text(label, key: ValueKey(label))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Send and stop as one round button. [stop] switches it to cancelling the
/// running operation.
class SendStopButton extends StatelessWidget {
  const SendStopButton({
    required this.stop,
    required this.onSend,
    required this.onStop,
    super.key,
  });
  final bool stop;
  final VoidCallback? onSend;
  final VoidCallback? onStop;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final colors = HarnessColors.of(context);
    final duration = motion(context);
    final pressed = stop ? onStop : onSend;
    final background = pressed == null
        ? colors.fill
        : stop
        ? scheme.onSurface
        : scheme.primary;
    final foreground = pressed == null
        ? colors.idle
        : stop
        ? Theme.of(context).scaffoldBackgroundColor
        : scheme.onPrimary;
    return TweenAnimationBuilder<Color?>(
      tween: ColorTween(end: background),
      duration: duration,
      curve: motionCurve,
      builder: (context, fill, _) => IconButton.filled(
        tooltip: stop ? 'Cancel operation' : 'Send prompt',
        onPressed: pressed,
        style: IconButton.styleFrom(
          backgroundColor: fill,
          disabledBackgroundColor: fill,
          foregroundColor: foreground,
          disabledForegroundColor: foreground,
        ),
        icon: AnimatedSwitcher(
          duration: duration,
          switchInCurve: motionCurve,
          switchOutCurve: motionCurve,
          transitionBuilder: (child, animation) => ScaleTransition(
            scale: Tween(begin: .6, end: 1.0).animate(animation),
            child: FadeTransition(opacity: animation, child: child),
          ),
          child: Icon(
            stop ? Icons.stop_rounded : Icons.arrow_upward_rounded,
            key: ValueKey(stop),
          ),
        ),
      ),
    );
  }
}

/// Copy icon that turns into a check for 1.5 s after copying.
class CopyIconButton extends StatefulWidget {
  const CopyIconButton({required this.text, required this.tooltip, super.key});
  final String text;
  final String tooltip;
  @override
  State<CopyIconButton> createState() => _CopyIconButtonState();
}

class _CopyIconButtonState extends State<CopyIconButton> {
  bool copied = false;
  Timer? reset;
  @override
  void dispose() {
    reset?.cancel();
    super.dispose();
  }

  Future<void> copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    if (!mounted) return;
    setState(() => copied = true);
    reset?.cancel();
    reset = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => copied = false);
    });
  }

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: copied ? 'Copied' : widget.tooltip,
    onPressed: copy,
    icon: AnimatedSwitcher(
      duration: motion(context),
      switchInCurve: motionCurve,
      switchOutCurve: motionCurve,
      transitionBuilder: (child, animation) => ScaleTransition(
        scale: Tween(begin: .6, end: 1.0).animate(animation),
        child: FadeTransition(opacity: animation, child: child),
      ),
      child: Icon(
        copied ? Icons.check_rounded : Icons.copy_rounded,
        key: ValueKey(copied),
        size: 20,
        color: copied ? HarnessColors.of(context).success : null,
      ),
    ),
  );
}

/// Raw JSON and tokens: monospace on a soft fill, selectable.
class CodeBlock extends StatelessWidget {
  const CodeBlock(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(Space.m),
    decoration: BoxDecoration(
      color: HarnessColors.of(context).fill,
      borderRadius: BorderRadius.circular(12),
    ),
    child: SelectableText(
      text,
      style: const TextStyle(
        fontFamily: 'monospace',
        fontSize: 12,
        height: 1.4,
      ),
    ),
  );
}

/// Dialog with left-aligned content and actions in reading order, primary
/// first.
AlertDialog plainDialog({
  Widget? title,
  Widget? content,
  List<Widget>? actions,
}) => AlertDialog(
  title: title,
  content: content,
  actions: actions,
  actionsAlignment: MainAxisAlignment.start,
  actionsOverflowAlignment: OverflowBarAlignment.start,
  actionsOverflowDirection: VerticalDirection.down,
);

/// Asks before pushing [device] off control. True takes over; "View only"
/// and dismissing return false.
Future<bool> takeoverDialog(BuildContext context, String device) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => plainDialog(
        title: Text('$device is in control'),
        content: const Text(
          'Taking over pushes that device off; it can only watch. Running tasks are not interrupted.',
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Take over'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('View only'),
          ),
        ],
      ),
    ) ??
    false;

/// Short local time for status lines.
String shortTime(DateTime value) {
  final local = value.toLocal();
  final now = DateTime.now();
  String two(int v) => v.toString().padLeft(2, '0');
  final time = '${two(local.hour)}:${two(local.minute)}';
  if (local.year == now.year &&
      local.month == now.month &&
      local.day == now.day) {
    return time;
  }
  return '${local.year}-${two(local.month)}-${two(local.day)} $time';
}

/// Opens [url] outside the app, in the browser or the app that handles it.
/// False when nothing could open it.
Future<bool> openExternally(Uri url) =>
    launchUrl(url, mode: LaunchMode.externalApplication);
