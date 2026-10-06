/// Folders on the DSH host. For a new session the folders the host allows
/// come first and a folder browser reaches the rest; choosing a checkout opens
/// the browser directly. The Host decides what may be listed (only inside the
/// allowed folders, unless “允许远程选择本机任意目录” is on there). Host paths
/// are shown, split and converted only through host_path.dart, never with
/// this phone's own path rules.
library;

import 'package:flutter/material.dart';

import 'api.dart';
import 'host_path.dart';
import 'models.dart';
import 'store.dart';
import 'theme.dart';
import 'ui.dart';

class Place {
  const Place(this.name, this.path);
  final String name;
  final String path;
}

List<Place> places(Object? value) => [
  for (final raw in value is List ? value : const [])
    if (object(raw) case {'name': final String name, 'path': final String path})
      Place(name, path),
];

/// Host error codes of the folder commands and `session.create`, in plain
/// words.
String workspaceErrorText(Object error) => switch (error) {
  ApiException(code: 'workspace_forbidden') =>
    'That folder is outside what this host allows remotely.',
  ApiException(code: 'no_workspace') =>
    'This host has no folders allowed for remote sessions yet.',
  ApiException(code: 'not_found') => 'That folder doesn\'t exist on the host.',
  ApiException(code: 'not_a_directory') => 'That is not a folder.',
  ApiException(code: 'access_denied') =>
    'That folder can\'t be read on the host.',
  _ => error.toString(),
};

/// Whether [instance] can browse its folders now: online, on a plugin with
/// `workspace.browse`.
bool canBrowseFolders(Instance? instance) =>
    instance != null &&
    instance.online &&
    instance.capabilities.contains('workspace.browse');

/// An example absolute path in a host's style, for hints.
String hostPathExample(HostPathStyle? style) =>
    style == HostPathStyle.windows ? r'C:\work\repo' : '/home/me/repo';

/// The "New session" dialog for a Host that can list its folders. Returns
/// the chosen folder, or null when cancelled.
Future<String?> showNewSessionDialog(
  BuildContext context, {
  required RemoteStore store,
  required String instanceId,
}) => showDialog<String>(
  context: context,
  builder: (_) => NewSessionDialog(store: store, instanceId: instanceId),
);

/// Picks one existing folder on the Host, starting at [initial] or at the
/// starting places. Returns its canonical host path, or null when cancelled.
Future<String?> showFolderChooser(
  BuildContext context, {
  required RemoteStore store,
  required String instanceId,
  String? initial,
}) => showDialog<String>(
  context: context,
  builder: (_) => NewSessionDialog(
    store: store,
    instanceId: instanceId,
    choose: true,
    initial: initial,
  ),
);

class _Listing {
  const _Listing(this.path, this.parent, this.directories, this.truncated);
  final String? path;
  final String? parent;
  final List<Place> directories;
  final bool truncated;
}

/// The folder picker: the allowed folders and a browser for a new session,
/// or only the browser with [choose].
class NewSessionDialog extends StatefulWidget {
  const NewSessionDialog({
    required this.store,
    required this.instanceId,
    this.choose = false,
    this.initial,
    super.key,
  });
  final RemoteStore store;
  final String instanceId;

  /// Choose a folder and return it, instead of creating a session.
  final bool choose;

  /// Where choosing starts; the starting places when null.
  final String? initial;
  @override
  State<NewSessionDialog> createState() => _NewSessionDialogState();
}

class _NewSessionDialogState extends State<NewSessionDialog> {
  /// The allowed folders; null until `workspace.list` answers.
  List<Place>? roots;
  bool anyWorkspace = false;
  String? listError;
  String? selected;

  /// The host's path style and home folder, as `workspace.list` reports them.
  HostPathStyle? style;
  String? home;

  /// The folder list, or the browser in the same place.
  late bool browsing = widget.choose;

  /// What the browser shows: null before the first answer; a null path is
  /// where browsing starts.
  _Listing? listing;
  bool loading = false;
  String? browseError;
  int request = 0;

  /// The "Go to path" field, collapsed behind its icon button.
  bool goingTo = false;
  final goTo = TextEditingController();

  @override
  void initState() {
    super.initState();
    loadRoots();
    if (widget.choose) browse(widget.initial);
  }

  @override
  void dispose() {
    goTo.dispose();
    super.dispose();
  }

  Future<JsonMap> read(String action, JsonMap args) async =>
      object(await widget.store.command(widget.instanceId, action, args));

  /// The host's path style: reported, or, for hosts that predate `style`,
  /// shown by the paths they return.
  HostPathStyle? get hostStyle =>
      style ??
      widget.store.hostStyle(widget.instanceId) ??
      inferHostPathStyle([
        ?listing?.path,
        for (final place in listing?.directories ?? const <Place>[]) place.path,
      ]);

  Future<void> loadRoots() async {
    if (listError != null) setState(() => listError = null);
    try {
      final data = await read('workspace.list', {});
      if (!mounted) return;
      final found = places(data['roots']);
      final reported =
          parseHostPathStyle(data['style']) ??
          inferHostPathStyle(found.map((place) => place.path));
      if (reported != null) {
        widget.store.hostStyles[widget.instanceId] = reported;
      }
      setState(() {
        roots = found;
        anyWorkspace = data['anyWorkspace'] == true;
        style = reported;
        home = data['home'] is String ? data['home'] as String : null;
        if (!widget.choose) selected ??= found.firstOrNull?.path;
      });
    } catch (e) {
      if (mounted) setState(() => listError = workspaceErrorText(e));
    }
  }

  /// Lists [path], or the starting places when it is null. A failure keeps
  /// the folder on screen and says why. True when the folder was listed.
  Future<bool> browse(String? path) async {
    final ticket = ++request;
    setState(() {
      loading = true;
      browseError = null;
    });
    try {
      final data = await read('workspace.browse', {'path': ?path});
      if (!mounted || ticket != request) return false;
      setState(() {
        listing = _Listing(
          data['path'] is String ? data['path'] as String : null,
          data['parent'] is String ? data['parent'] as String : null,
          places(data['directories']),
          data['truncated'] == true,
        );
        loading = false;
      });
      return true;
    } catch (e) {
      if (!mounted || ticket != request) return false;
      setState(() {
        loading = false;
        browseError = workspaceErrorText(e);
      });
      return false;
    }
  }

  /// Browses to the path typed in "Go to path", converted to the host's
  /// style first; the host still resolves it and decides what may be listed.
  Future<void> goToPath() async {
    final style = hostStyle;
    final input = goTo.text;
    final target = style == null
        ? toHostPath(input, HostPathStyle.posix) ??
              toHostPath(input, HostPathStyle.windows)
        : toHostPath(input, style);
    if (target == null) {
      setState(
        () => browseError =
            'Enter an absolute path on this host, like ${hostPathExample(style)}.',
      );
      return;
    }
    if (await browse(target) && mounted) {
      setState(() {
        goingTo = false;
        goTo.clear();
      });
    }
  }

  void openBrowser() {
    setState(() {
      browsing = true;
      listing = null;
    });
    browse(selected);
  }

  void showFolders([String? chosen]) {
    request++;
    setState(() {
      if (chosen != null) selected = chosen;
      browsing = false;
      loading = false;
      browseError = null;
      goingTo = false;
    });
  }

  /// Whether a breadcrumb may be opened: inside an allowed folder, or
  /// anywhere when the host allows any folder.
  bool reachable(String folder) {
    final roots = this.roots;
    if (anyWorkspace || roots == null) return true;
    return roots.any((root) => hostPathWithin(folder, root.path));
  }

  @override
  Widget build(BuildContext context) {
    final ready = roots != null && selected != null;
    return plainDialog(
      title: Text(widget.choose ? 'Choose folder' : 'New session'),
      content: SizedBox(
        width: 480,
        child: Resize(
          child: AnimatedSwitcher(
            duration: motion(context),
            switchInCurve: motionCurve,
            switchOutCurve: motionCurve,
            transitionBuilder: fadeSlide,
            layoutBuilder: (current, previous) => Stack(
              alignment: AlignmentDirectional.topStart,
              children: [...previous, ?current],
            ),
            child: KeyedSubtree(
              key: ValueKey(browsing),
              child: browsing ? browser(context) : folders(context),
            ),
          ),
        ),
      ),
      actions: [
        if (!widget.choose)
          FilledButton(
            onPressed: ready ? () => Navigator.pop(context, selected) : null,
            child: const Text('Create session'),
          ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
      ],
    );
  }

  Widget scrollable(List<Widget> rows) => ConstrainedBox(
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * .4,
    ),
    child: ListView.builder(
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      itemCount: rows.length,
      itemBuilder: (context, index) => rows[index],
    ),
  );

  Widget quiet(String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: Space.s),
    child: Text(
      value,
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
        color: HarnessColors.of(context).secondary,
      ),
    ),
  );

  Widget get spinner => const Padding(
    padding: EdgeInsets.symmetric(vertical: Space.m),
    child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator()),
  );

  Widget folders(BuildContext context) {
    final roots = this.roots;
    final chosen = selected;
    // A folder chosen in the browser leads the list.
    final custom = chosen != null && !(roots ?? []).any((r) => r.path == chosen)
        ? Place(hostPathName(chosen), chosen)
        : null;
    final shown = [?custom, ...?roots];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Workspace folder',
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: HarnessColors.of(context).secondary,
          ),
        ),
        const SizedBox(height: Space.s),
        if (roots == null && listError == null)
          spinner
        else if (roots != null && roots.isEmpty && !anyWorkspace)
          quiet(
            'This host has no folders allowed for remote sessions yet. On the DSH computer, open Plugins → DSH Remote and add a workspace folder, or turn on “允许远程选择本机任意目录”.',
          )
        else if (shown.isNotEmpty)
          scrollable([
            for (final place in shown)
              FolderRow(
                key: ValueKey(place.path),
                icon: Icons.folder_outlined,
                title: place.name,
                subtitle: place.path,
                selected: place.path == chosen,
                onTap: () => setState(() => selected = place.path),
              ),
          ]),
        if (listError != null) ...[
          const SizedBox(height: Space.s),
          ErrorNotice(listError!),
          TextButton(
            style: edgeAction,
            onPressed: loadRoots,
            child: const Text('Try again'),
          ),
        ] else if (roots != null && (roots.isNotEmpty || anyWorkspace)) ...[
          const SizedBox(height: Space.xs),
          TextButton(
            style: edgeAction,
            onPressed: openBrowser,
            child: Text(
              anyWorkspace ? 'Browse other folders' : 'Choose subfolder',
            ),
          ),
        ],
      ],
    );
  }

  Widget browser(BuildContext context) {
    final here = listing;
    final path = here?.path;
    final text = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            if (!widget.choose)
              IconButton(
                tooltip: 'Back to folders',
                onPressed: showFolders,
                icon: const Icon(Icons.arrow_back_rounded, size: 20),
              ),
            Expanded(
              child: path == null
                  ? Text(
                      here == null
                          ? ''
                          : anyWorkspace
                          ? 'This computer'
                          : 'Allowed folders',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: text.titleSmall,
                    )
                  : HostPathBreadcrumbs(
                      path: path,
                      reachable: reachable,
                      onOpen: loading ? null : browse,
                    ),
            ),
            IconButton(
              tooltip: goingTo ? 'Hide path field' : 'Go to path',
              onPressed: () => setState(() {
                goingTo = !goingTo;
                if (!goingTo) goTo.clear();
              }),
              icon: Swap(
                child: Icon(
                  goingTo ? Icons.close_rounded : Icons.edit_outlined,
                  key: ValueKey(goingTo),
                  size: 20,
                ),
              ),
            ),
          ],
        ),
        Reveal(
          padding: const EdgeInsets.only(bottom: Space.s),
          child: goingTo ? goToField() : null,
        ),
        const SizedBox(height: Space.xs),
        if (loading)
          spinner
        else if (here != null) ...[
          scrollable([
            if (path != null)
              FolderRow(
                icon: Icons.arrow_upward_rounded,
                title: 'Up',
                onTap: () => browse(here.parent),
              ),
            for (final folder in here.directories)
              FolderRow(
                key: ValueKey(folder.path),
                icon: Icons.folder_outlined,
                title: folder.name,
                // Starting places come from anywhere; inside a folder the
                // breadcrumbs above say where they are.
                subtitle: path == null ? folder.path : null,
                trailing: Icon(
                  Icons.chevron_right_rounded,
                  size: 20,
                  color: HarnessColors.of(context).secondary,
                ),
                onTap: () => browse(folder.path),
              ),
          ]),
          if (here.directories.isEmpty) quiet('No subfolders'),
          if (here.truncated) quiet('Showing the first 500 folders'),
        ],
        Reveal(
          padding: const EdgeInsets.only(top: Space.s),
          child: browseError == null ? null : ErrorNotice(browseError!),
        ),
        if (path != null) ...[
          const SizedBox(height: Space.m),
          OutlinedButton(
            // A checkout is never a whole drive or filesystem.
            onPressed: loading || (widget.choose && !isCanonicalHostPath(path))
                ? null
                : () => widget.choose
                      ? Navigator.pop(context, path)
                      : showFolders(path),
            child: const Text('Use this folder'),
          ),
        ],
      ],
    );
  }

  Widget goToField() => Row(
    children: [
      Expanded(
        child: TextField(
          controller: goTo,
          autofocus: true,
          autocorrect: false,
          enableSuggestions: false,
          keyboardType: TextInputType.url,
          textInputAction: TextInputAction.go,
          decoration: InputDecoration(
            isDense: true,
            labelText: 'Go to path',
            hintText: home ?? hostPathExample(hostStyle),
          ),
          onSubmitted: (_) => goToPath(),
        ),
      ),
      const SizedBox(width: Space.s),
      TextButton(onPressed: loading ? null : goToPath, child: const Text('Go')),
    ],
  );
}

/// A host path as breadcrumbs: the root first, each folder after it. Every
/// folder but the current one opens when tapped, as far as [reachable]
/// allows. Long paths scroll sideways and start scrolled to the end.
class HostPathBreadcrumbs extends StatelessWidget {
  const HostPathBreadcrumbs({
    required this.path,
    required this.onOpen,
    this.reachable,
    super.key,
  });
  final String path;
  final ValueChanged<String>? onOpen;
  final bool Function(String path)? reachable;
  @override
  Widget build(BuildContext context) {
    final colors = HarnessColors.of(context);
    final text = Theme.of(context).textTheme;
    final crumbs = hostPathCrumbs(path);
    return Semantics(
      label: path,
      container: true,
      child: LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          reverse: true,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: constraints.maxWidth),
            child: Row(
              children: [
                for (final (index, crumb) in crumbs.indexed) ...[
                  if (index > 0)
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 16,
                      color: colors.secondary,
                    ),
                  if (index == crumbs.length - 1)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: Space.xs),
                      child: Text(crumb.name, style: text.titleSmall),
                    )
                  else if (onOpen != null &&
                      (reachable?.call(crumb.path) ?? true))
                    TextButton(
                      style: TextButton.styleFrom(
                        foregroundColor: colors.secondary,
                        minimumSize: const Size(0, 40),
                        padding: const EdgeInsets.symmetric(
                          horizontal: Space.xs,
                        ),
                        textStyle: text.titleSmall,
                      ),
                      onPressed: () => onOpen!(crumb.path),
                      child: Text(crumb.name),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: Space.xs),
                      child: Text(
                        crumb.name,
                        style: text.titleSmall?.copyWith(
                          color: text.bodySmall?.color,
                        ),
                      ),
                    ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// New session on a host whose plugin predates the folder picker: it says
/// how to update and still offers the default folder. True creates there.
Future<bool> showOldPluginDialog(
  BuildContext context, {
  required RemoteStore store,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (_) => OldPluginDialog(store: store),
    ) ??
    false;

class OldPluginDialog extends StatefulWidget {
  const OldPluginDialog({required this.store, super.key});
  final RemoteStore store;
  @override
  State<OldPluginDialog> createState() => _OldPluginDialogState();
}

class _OldPluginDialogState extends State<OldPluginDialog> {
  late final Future<String?> package = widget.store.pluginPackageUrl();
  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return plainDialog(
      title: const Text('New session'),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'This host’s DSH Remote plugin is too old to browse folders; update it from the plugin page in DSH.',
            ),
            FutureBuilder<String?>(
              future: package,
              builder: (context, snapshot) => Reveal(
                padding: const EdgeInsets.only(top: Space.l),
                child: snapshot.data == null
                    ? null
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Current plugin package',
                            style: text.labelMedium?.copyWith(
                              color: HarnessColors.of(context).secondary,
                            ),
                          ),
                          Row(
                            children: [
                              Expanded(
                                child: SelectableText(
                                  snapshot.data!,
                                  style: text.bodySmall,
                                ),
                              ),
                              CopyIconButton(
                                text: snapshot.data!,
                                tooltip: 'Copy package address',
                              ),
                            ],
                          ),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Create in default folder'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

/// One folder in the picker. The selected one has a soft fill and a check.
class FolderRow extends StatelessWidget {
  const FolderRow({
    required this.icon,
    required this.title,
    required this.onTap,
    this.subtitle,
    this.trailing,
    this.selected = false,
    super.key,
  });
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final colors = HarnessColors.of(context);
    final text = Theme.of(context).textTheme;
    final radius = BorderRadius.circular(12);
    final mark = selected
        ? Icon(
            Icons.check_rounded,
            key: const ValueKey('selected'),
            size: 20,
            color: Theme.of(context).colorScheme.primary,
          )
        : trailing;
    return Semantics(
      selected: selected,
      child: AnimatedContainer(
        duration: motion(context),
        curve: motionCurve,
        decoration: BoxDecoration(
          color: selected ? colors.fill : colors.fill.withValues(alpha: 0),
          borderRadius: radius,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            borderRadius: radius,
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: Space.m,
                vertical: Space.s,
              ),
              child: Row(
                children: [
                  Icon(icon, size: 20, color: colors.secondary),
                  const SizedBox(width: Space.m),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: text.bodyMedium,
                        ),
                        if (subtitle != null)
                          Text(
                            subtitle!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: text.bodySmall,
                          ),
                      ],
                    ),
                  ),
                  if (mark != null) ...[
                    const SizedBox(width: Space.s),
                    Swap(child: mark),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
