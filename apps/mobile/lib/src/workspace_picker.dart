/// Folder choice for a new session: the folders the DSH computer allows come
/// first, and a folder browser reaches the rest. The Host decides what may be
/// listed (only inside the allowed folders, unless “允许远程选择本机任意目录” is
/// on there); this view never sends a typed path.
library;

import 'package:flutter/material.dart';

import 'api.dart';
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

String lastSegment(String path) =>
    path.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty).lastOrNull ??
    path;

/// Host error codes of the folder commands and `session.create`, in plain
/// words.
String workspaceErrorText(Object error) => switch (error) {
  ApiException(code: 'workspace_forbidden') =>
    'That folder is outside what this host allows remotely.',
  ApiException(code: 'no_workspace') =>
    'This host has no folders allowed for remote sessions yet.',
  ApiException(code: 'not_found') => 'That folder no longer exists.',
  ApiException(code: 'not_a_directory') => 'That is not a folder.',
  ApiException(code: 'access_denied') =>
    'That folder can\'t be read on the host.',
  _ => error.toString(),
};

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

class _Listing {
  const _Listing(this.path, this.parent, this.directories, this.truncated);
  final String? path;
  final String? parent;
  final List<Place> directories;
  final bool truncated;
}

class NewSessionDialog extends StatefulWidget {
  const NewSessionDialog({
    required this.store,
    required this.instanceId,
    super.key,
  });
  final RemoteStore store;
  final String instanceId;
  @override
  State<NewSessionDialog> createState() => _NewSessionDialogState();
}

class _NewSessionDialogState extends State<NewSessionDialog> {
  /// The allowed folders; null until `workspace.list` answers.
  List<Place>? roots;
  bool anyWorkspace = false;
  String? listError;
  String? selected;

  /// The folder list, or the browser in the same place.
  bool browsing = false;

  /// What the browser shows: null before the first answer; a null path is
  /// where browsing starts.
  _Listing? listing;
  bool loading = false;
  String? browseError;
  int request = 0;

  @override
  void initState() {
    super.initState();
    loadRoots();
  }

  Future<JsonMap> read(String action, JsonMap args) async =>
      object(await widget.store.command(widget.instanceId, action, args));

  Future<void> loadRoots() async {
    if (listError != null) setState(() => listError = null);
    try {
      final data = await read('workspace.list', {});
      if (!mounted) return;
      setState(() {
        roots = places(data['roots']);
        anyWorkspace = data['anyWorkspace'] == true;
        selected ??= roots!.firstOrNull?.path;
      });
    } catch (e) {
      if (mounted) setState(() => listError = workspaceErrorText(e));
    }
  }

  /// Lists [path], or the starting places when it is null. A failure keeps
  /// the folder on screen and says why.
  Future<void> browse(String? path) async {
    final ticket = ++request;
    setState(() {
      loading = true;
      browseError = null;
    });
    try {
      final data = await read('workspace.browse', {'path': ?path});
      if (!mounted || ticket != request) return;
      setState(() {
        listing = _Listing(
          data['path'] is String ? data['path'] as String : null,
          data['parent'] is String ? data['parent'] as String : null,
          places(data['directories']),
          data['truncated'] == true,
        );
        loading = false;
      });
    } catch (e) {
      if (!mounted || ticket != request) return;
      setState(() {
        loading = false;
        browseError = workspaceErrorText(e);
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
    });
  }

  @override
  Widget build(BuildContext context) {
    final ready = roots != null && selected != null;
    return plainDialog(
      title: const Text('New session'),
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
        ? Place(lastSegment(chosen), chosen)
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
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            IconButton(
              tooltip: 'Back to folders',
              onPressed: showFolders,
              icon: const Icon(Icons.arrow_back_rounded, size: 20),
            ),
            Expanded(
              child: Text(
                path ??
                    (here == null
                        ? ''
                        : anyWorkspace
                        ? 'This computer'
                        : 'Allowed folders'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
          ],
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
                // path above says where they are.
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
            onPressed: loading ? null : () => showFolders(path),
            child: const Text('Use this folder'),
          ),
        ],
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
