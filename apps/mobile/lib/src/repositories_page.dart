import 'package:flutter/material.dart';

import 'api.dart';
import 'host_path.dart';
import 'models.dart';
import 'store.dart';
import 'theme.dart';
import 'ui.dart';
import 'workspace_picker.dart';

class RepositoriesPage extends StatefulWidget {
  const RepositoriesPage({
    required this.store,
    required this.instanceId,
    this.initialIds = const [],
    this.pickForMessage = false,
    this.openUrl = openExternally,
    super.key,
  });
  final RemoteStore store;
  final String instanceId;
  final List<String> initialIds;
  final bool pickForMessage;

  /// Opens an address outside the app (GitHub's installation page).
  final Future<bool> Function(Uri url) openUrl;
  @override
  State<RepositoriesPage> createState() => _RepositoriesPageState();
}

class _RepositoriesPageState extends State<RepositoriesPage>
    with WidgetsBindingObserver {
  bool busy = false;
  String? error;
  String? notice;
  int tab = 0;
  int operation = 0;
  int installationPage = 1;
  int repositoryPage = 1;
  bool moreInstallations = false;
  bool moreRepositories = false;
  int? installationId;

  /// GitHub was looked at since the tab first opened.
  bool discovered = false;

  /// The installation list loaded; empty means the App is not installed.
  bool installationsLoaded = false;

  /// GitHub's installation page was opened; returning refreshes the list.
  bool awaitingInstall = false;
  List<JsonMap> installations = [];
  List<JsonMap> available = [];
  final Map<int, JsonMap> selectedGithub = {};
  late final Set<String> selected = widget.initialIds.toSet();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.store.addListener(changed);
    refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.store.removeListener(changed);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from installing the GitHub App: show what it may read now.
    if (state == AppLifecycleState.resumed && awaitingInstall && tab == 1) {
      awaitingInstall = false;
      discover();
    }
  }

  void changed() {
    if (mounted) setState(() {});
  }

  Future<void> run(Future<void> Function() work) async {
    if (busy) return;
    final generation = ++operation;
    setState(() {
      busy = true;
      error = null;
      notice = null;
    });
    try {
      await work();
    } catch (e) {
      if (mounted && generation == operation) {
        setState(() => error = e.toString());
      }
    } finally {
      if (mounted && generation == operation) {
        setState(() => busy = false);
        // The GitHub tab opened while something else was loading.
        if (tab == 1 && !discovered) discover();
      }
    }
  }

  Future<void> refresh() => run(() async {
    await widget.store.refreshRepositories(widget.instanceId);
    if (tab == 1) {
      await loadGithub();
    } else {
      await widget.store.refreshGithub();
    }
    await widget.store.refreshInstance(widget.instanceId);
  });

  /// GitHub status, then the installations and the chosen one's
  /// repositories. A single installation is chosen at once.
  Future<void> loadGithub({bool reloadInstallations = true}) async {
    discovered = true;
    final status = await widget.store.refreshGithub();
    if (status['state'] != 'connected') return;
    if (reloadInstallations) {
      final result = await widget.store.githubInstallations(
        page: installationPage,
      );
      if (!mounted) return;
      installations = (result['installations'] as List? ?? [])
          .map(object)
          .toList();
      moreInstallations = result['hasMore'] == true;
      installationsLoaded = true;
      if (!installations.any((i) => i['id'] == installationId)) {
        installationId = installations.isEmpty
            ? null
            : (installations.first['id'] as num).toInt();
      }
      repositoryPage = 1;
    }
    if (installationId == null) {
      available = [];
      moreRepositories = false;
      return;
    }
    final result = await widget.store.githubRepositories(
      installationId!,
      page: repositoryPage,
      installationPage: installationPage,
    );
    if (!mounted) return;
    available = (result['repositories'] as List? ?? []).map(object).toList();
    moreRepositories = result['hasMore'] == true;
  }

  Future<void> discover({bool reloadInstallations = true}) =>
      run(() => loadGithub(reloadInstallations: reloadInstallations));

  /// Opens GitHub's page for installing the App and choosing the
  /// repositories it may read.
  Future<void> installGithub() => run(() async {
    final url = await widget.store.githubInstallUrl();
    final opened = await widget
        .openUrl(Uri.parse(url))
        .catchError((Object _) => false);
    if (!opened) {
      throw ApiException(
        'open_failed',
        'Could not open GitHub. Open $url in a browser, then refresh here.',
      );
    }
    awaitingInstall = true;
  });

  Future<void> mapManual() async {
    final mapping = await showDialog<JsonMap>(
      context: context,
      builder: (_) => RepositoryMappingDialog(
        store: widget.store,
        instanceId: widget.instanceId,
      ),
    );
    if (mapping == null || !mounted) return;
    await run(() async {
      await widget.store.mapRepository(widget.instanceId, mapping);
      if (mounted) {
        setState(() {
          tab = 0;
          notice =
              'Reference declared. Take control and verify the existing checkout before adding it to a message.';
        });
      }
    });
  }

  Future<void> mapGithub() async {
    final candidates = selectedGithub.values.toList();
    if (candidates.isEmpty) return;
    final mappings = await showDialog<List<JsonMap>>(
      context: context,
      builder: (_) => GithubMappingsDialog(
        repositories: candidates,
        store: widget.store,
        instanceId: widget.instanceId,
      ),
    );
    if (mappings == null || !mounted) return;
    await run(() async {
      final epoch = operation;
      for (final mapping in mappings) {
        if (!mounted || epoch != operation) return;
        await widget.store.mapRepository(widget.instanceId, mapping);
        selectedGithub.remove(mapping['repositoryId']);
      }
      if (mounted && epoch == operation) {
        setState(() {
          tab = 0;
          notice =
              'References declared. Verify each local checkout explicitly before using message context.';
        });
      }
    });
  }

  Future<void> preview(RepositoryReference reference) =>
      showRepositoryPreview(context, [reference]);
  void choose(RepositoryReference reference, bool? value) {
    if (value == true && selected.length >= 8) {
      setState(() => error = 'Choose at most 8 repository references.');
      return;
    }
    setState(() {
      value == true
          ? selected.add(reference.id)
          : selected.remove(reference.id);
    });
  }

  Future<void> disconnect() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => plainDialog(
        title: const Text('Disconnect GitHub?'),
        content: const Text(
          'Remove this relay account’s saved GitHub grant. Local references and files stay on the instance. This does not revoke the GitHub App on GitHub.',
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
        ],
      ),
    );
    if (confirmed == true) await run(widget.store.disconnectGithub);
  }

  void stopWaiting() {
    operation++;
    widget.store.stopWaiting(widget.instanceId);
    setState(() {
      busy = false;
      notice =
          'Stopped waiting. A submitted operation may still finish; refresh the original result before retrying.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final references = widget.store.repositories[widget.instanceId] ?? [];
    final chosen = references.where((r) => selected.contains(r.id)).toList();
    final selectionError = chosen.length == selected.length
        ? repositorySelectionError(chosen, widget.instanceId)
        : 'A selected reference is no longer available. Remove it and refresh.';
    final instance = widget.store.instance(widget.instanceId);
    final text = Theme.of(context).textTheme;
    final message = error ?? notice;
    return Scaffold(
      appBar: AppBar(
        actions: [
          IconButton(
            tooltip: 'Refresh repositories',
            onPressed: busy ? null : refresh,
            icon: const Icon(Icons.refresh),
          ),
          const SizedBox(width: Space.xs),
        ],
      ),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            BusyBar(busy: busy, onStop: stopWaiting),
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.l, Space.s, Space.l, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Repositories', style: text.headlineMedium),
                  const SizedBox(height: Space.xs),
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          '${instance?.name ?? widget.instanceId} · ${widget.store.canWrite(widget.instanceId) ? 'Writer' : 'Observer'}',
                          style: text.bodySmall,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: Space.m),
                      StatusDot.instance(widget.store, instance),
                    ],
                  ),
                  const SizedBox(height: Space.l),
                  Transform.translate(
                    offset: segmentEdgeOffset,
                    child: SegmentedButton<int>(
                      showSelectedIcon: false,
                      segments: const [
                        ButtonSegment(
                          value: 0,
                          label: Text('Local references'),
                        ),
                        ButtonSegment(value: 1, label: Text('GitHub')),
                      ],
                      selected: {tab},
                      onSelectionChanged: (values) {
                        setState(() => tab = values.first);
                        // While busy, the running operation looks after it.
                        if (tab == 1 && !discovered && !busy) discover();
                      },
                    ),
                  ),
                ],
              ),
            ),
            Reveal(
              padding: const EdgeInsets.fromLTRB(Space.l, Space.m, Space.l, 0),
              child: message == null
                  ? null
                  : Notice(
                      message,
                      error: error != null,
                      onDismiss: () => setState(() {
                        error = null;
                        notice = null;
                      }),
                    ),
            ),
            Expanded(child: tab == 0 ? localList(references) : githubList()),
            if (widget.pickForMessage)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Space.l,
                  Space.s,
                  Space.l,
                  Space.m,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Reveal(
                      padding: const EdgeInsets.only(bottom: Space.s),
                      child: selectionError == null
                          ? null
                          : Text(
                              selectionError,
                              style: text.bodySmall?.copyWith(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            ),
                    ),
                    FilledButton(
                      onPressed: busy || selectionError != null
                          ? null
                          : () => Navigator.pop(context, selected.toList()),
                      child: Text(
                        'Use ${selected.length} reference${selected.length == 1 ? '' : 's'}',
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget localList(List<RepositoryReference> references) {
    final text = Theme.of(context).textTheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(Space.l, Space.xl, Space.l, Space.xl),
      children: [
        if (references.isEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: Space.l),
            child: Text(
              'No local references yet.',
              style: text.bodyMedium?.copyWith(
                color: HarnessColors.of(context).secondary,
              ),
            ),
          ),
        for (final reference in references) referenceItem(reference),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton(
            onPressed: busy ? null : mapManual,
            child: const Text('Map existing checkout'),
          ),
        ),
      ],
    );
  }

  Widget referenceItem(RepositoryReference reference) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.xl),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (widget.pickForMessage)
            Padding(
              padding: const EdgeInsets.only(right: Space.s),
              child: Checkbox(
                value: selected.contains(reference.id),
                onChanged:
                    busy ||
                        (!reference.verified &&
                            !selected.contains(reference.id))
                    ? null
                    : (v) => choose(reference, v),
              ),
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(reference.fullName, style: text.titleMedium),
                    ),
                    if (!reference.selected)
                      Text('Hidden', style: text.bodySmall),
                  ],
                ),
                const SizedBox(height: Space.xs),
                Text(
                  'Local: ${reference.localState} · Access: ${reference.authorization}',
                  style: text.bodySmall,
                ),
                SelectableText(reference.localPath, style: text.bodySmall),
                if (reference.json['branch'] != null)
                  Text(
                    'Branch: ${reference.json['branch']} · verified ${reference.json['verifiedAt'] == null ? 'unknown' : DateTime.fromMillisecondsSinceEpoch((reference.json['verifiedAt'] as num).toInt()).toLocal()}',
                    style: text.bodySmall,
                  ),
                if (!reference.verified)
                  Padding(
                    padding: const EdgeInsets.only(top: Space.xs),
                    child: Text(
                      'Add to message only after host verification. Files and working directory stay unchanged.',
                      style: text.bodySmall?.copyWith(
                        color: HarnessColors.of(context).warningLabel,
                      ),
                    ),
                  ),
                Wrap(
                  spacing: Space.l,
                  children: [
                    TextButton(
                      style: edgeAction,
                      onPressed:
                          busy ||
                              !widget.store.canWrite(widget.instanceId) ||
                              widget.store.hasUnresolvedWrite(widget.instanceId)
                          ? null
                          : () => run(
                              () => widget.store.inspectRepository(
                                widget.instanceId,
                                reference.id,
                              ),
                            ),
                      child: const Text('Verify checkout'),
                    ),
                    TextButton(
                      style: edgeAction,
                      onPressed: () => preview(reference),
                      child: const Text('Preview metadata'),
                    ),
                    TextButton(
                      style: edgeAction,
                      onPressed: busy
                          ? null
                          : () => run(
                              () => widget.store.selectRepository(
                                widget.instanceId,
                                reference.id,
                                !reference.selected,
                              ),
                            ),
                      child: Text(
                        reference.selected
                            ? 'Hide reference'
                            : 'Show reference',
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget githubList() {
    final status = widget.store.githubStatus;
    final configured = status?['configured'] == true;
    final connected = status?['state'] == 'connected';
    // Connected, but the App is installed nowhere yet: GitHub shows it no
    // repositories until it is installed and given some.
    final notInstalled =
        connected && installationsLoaded && installations.isEmpty;
    final text = Theme.of(context).textTheme;
    final secondary = text.bodyMedium?.copyWith(
      color: HarnessColors.of(context).secondary,
    );
    Widget pager(
      String label, {
      required String previous,
      required String next,
      required VoidCallback? onPrevious,
      required VoidCallback? onNext,
    }) => Row(
      children: [
        Expanded(child: Text(label, style: text.bodySmall)),
        IconButton(
          tooltip: previous,
          onPressed: onPrevious,
          icon: const Icon(Icons.chevron_left),
        ),
        IconButton(
          tooltip: next,
          onPressed: onNext,
          icon: const Icon(Icons.chevron_right),
        ),
      ],
    );
    final pagedInstallations = installationPage > 1 || moreInstallations;
    return ListView(
      padding: const EdgeInsets.fromLTRB(Space.l, Space.xl, Space.l, Space.xl),
      children: [
        Text(
          connected
              ? 'Connected as ${object(status?['account'])['login']}'
              : !configured
              ? 'GitHub is not configured'
              : status?['state'] == 'expired'
              ? 'GitHub access expired'
              : 'GitHub is disconnected',
          style: text.titleMedium,
        ),
        if (!connected) ...[
          const SizedBox(height: Space.s),
          Text(
            'Native OAuth is not supported. Grant read-only access in the web app signed in to this same relay account, then refresh here.',
            style: text.bodySmall,
          ),
          const SizedBox(height: Space.xs),
          SelectableText(widget.store.server, style: text.bodySmall),
        ],
        if (!configured)
          Padding(
            padding: const EdgeInsets.only(top: Space.s),
            child: Text(
              'Ask the relay operator to configure a read-only GitHub App. Manual local mapping still works.',
              style: text.bodySmall,
            ),
          ),
        const SizedBox(height: Space.s),
        Wrap(
          spacing: Space.l,
          children: [
            // The empty state below has its own refresh.
            if (!notInstalled)
              TextButton(
                style: edgeAction,
                onPressed: busy ? null : () => discover(),
                child: const Text('Refresh GitHub access'),
              ),
            if (connected)
              TextButton(
                style: edgeAction,
                onPressed: busy ? null : disconnect,
                child: const Text('Disconnect GitHub'),
              ),
          ],
        ),
        if (notInstalled) ...[
          const SizedBox(height: Space.l),
          Text(
            'Install DSH Remote on GitHub and choose the repositories it may read.',
            style: text.bodyMedium,
          ),
          const SizedBox(height: Space.m),
          Wrap(
            spacing: Space.s,
            runSpacing: Space.s,
            children: [
              FilledButton(
                onPressed: busy ? null : installGithub,
                child: const Text('Install on GitHub'),
              ),
              TextButton(
                onPressed: busy ? null : () => discover(),
                child: const Text('Refresh'),
              ),
            ],
          ),
        ] else if (connected) ...[
          const SizedBox(height: Space.l),
          // One installation is simply used; choosing needs more than one.
          if (installations.length > 1 || pagedInstallations)
            DropdownButtonHideUnderline(
              child: DropdownButton<int>(
                isExpanded: true,
                value: installationId,
                borderRadius: BorderRadius.circular(12),
                items: [
                  for (final installation in installations)
                    DropdownMenuItem(
                      value: (installation['id'] as num).toInt(),
                      child: Text(
                        object(installation['account'])['login'].toString(),
                      ),
                    ),
                ],
                onChanged: busy
                    ? null
                    : (v) {
                        setState(() {
                          installationId = v;
                          repositoryPage = 1;
                        });
                        discover(reloadInstallations: false);
                      },
              ),
            ),
          if (pagedInstallations)
            pager(
              'Installation page $installationPage',
              previous: 'Previous installations',
              next: 'Next installations',
              onPrevious: busy || installationPage == 1
                  ? null
                  : () {
                      installationPage--;
                      discover();
                    },
              onNext: busy || !moreInstallations
                  ? null
                  : () {
                      installationPage++;
                      discover();
                    },
            ),
          if (available.isEmpty && !busy && installationsLoaded)
            Text(
              installations.length > 1 || pagedInstallations
                  ? 'No repositories on this page. Refresh access or choose another installation.'
                  : 'No repositories on this page. Choose repositories for DSH Remote on GitHub, then refresh.',
              style: secondary,
            ),
          for (final repository in available)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(repository['fullName'].toString()),
              subtitle: Text(
                '${repository['defaultBranch']} · ${repository['private'] == true ? 'Private' : 'Public'}${repository['archived'] == true ? ' · Archived' : ''}',
              ),
              value: selectedGithub.containsKey(repository['id']),
              onChanged: busy
                  ? null
                  : (selected) => setState(() {
                      final id = (repository['id'] as num).toInt();
                      if (selected == true) {
                        selectedGithub[id] = {
                          ...repository,
                          'page': repositoryPage,
                          'installationPage': installationPage,
                        };
                      } else {
                        selectedGithub.remove(id);
                      }
                    }),
            ),
          if (repositoryPage > 1 || moreRepositories)
            pager(
              'Repository page $repositoryPage',
              previous: 'Previous repositories',
              next: 'Next repositories',
              onPrevious: busy || repositoryPage == 1
                  ? null
                  : () {
                      repositoryPage--;
                      discover(reloadInstallations: false);
                    },
              onNext: busy || !moreRepositories
                  ? null
                  : () {
                      repositoryPage++;
                      discover(reloadInstallations: false);
                    },
            ),
          const SizedBox(height: Space.s),
          Wrap(
            spacing: Space.s,
            runSpacing: Space.s,
            children: [
              FilledButton(
                onPressed: busy || selectedGithub.isEmpty ? null : mapGithub,
                child: Text(
                  'Map ${selectedGithub.length} selected repositories',
                ),
              ),
              if (selectedGithub.isNotEmpty)
                TextButton(
                  onPressed: busy ? null : () => setState(selectedGithub.clear),
                  child: const Text('Clear selection'),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// Shown once in a mapping dialog that falls back to typed paths.
const folderPickerUnavailable =
    'The folder picker is available while the instance is online on an up-to-date plugin.';

class RepositoryMappingDialog extends StatefulWidget {
  const RepositoryMappingDialog({
    required this.store,
    required this.instanceId,
    super.key,
  });
  final RemoteStore store;
  final String instanceId;
  @override
  State<RepositoryMappingDialog> createState() =>
      _RepositoryMappingDialogState();
}

class _RepositoryMappingDialogState extends State<RepositoryMappingDialog> {
  final form = GlobalKey<FormState>();
  final url = TextEditingController();
  late final checkout = CheckoutPath(widget.store, widget.instanceId);
  final branch = TextEditingController(text: 'main');
  @override
  void dispose() {
    url.dispose();
    checkout.dispose();
    branch.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => plainDialog(
    title: const Text('Map existing checkout'),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Form(
          key: form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'This only records a reference. The path must already exist under this host’s allowed roots; verification is a separate writer action.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (!checkout.browsable) ...[
                const SizedBox(height: Space.xs),
                Text(
                  folderPickerUnavailable,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: Space.l),
              TextFormField(
                controller: url,
                decoration: const InputDecoration(
                  labelText: 'GitHub repository URL',
                  hintText: 'https://github.com/owner/repo',
                ),
                validator: (v) =>
                    RegExp(
                      r'^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
                    ).hasMatch(v?.trim() ?? '')
                    ? null
                    : 'Use a canonical GitHub HTTPS repository URL',
              ),
              const SizedBox(height: Space.m),
              CheckoutFolderField(
                checkout: checkout,
                label: checkout.browsable
                    ? 'Checkout folder'
                    : 'Existing absolute checkout path',
              ),
              const SizedBox(height: Space.m),
              TextFormField(
                controller: branch,
                decoration: const InputDecoration(labelText: 'Default branch'),
              ),
            ],
          ),
        ),
      ),
    ),
    actions: [
      FilledButton(
        onPressed: () {
          if (form.currentState!.validate()) {
            Navigator.pop(context, <String, dynamic>{
              'source': 'manual',
              'url': url.text.trim(),
              'localPath': checkout.value,
              'defaultBranch': branch.text.trim(),
            });
          }
        },
        child: const Text('Save reference'),
      ),
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
    ],
  );
}

/// [input] as a canonical checkout path on a host with [style], or null when
/// it cannot be one. With the style unknown, the input's own style decides.
String? hostCheckoutPath(String? input, HostPathStyle? style) {
  final value = input ?? '';
  final converted = style == null
      ? toHostPath(value, HostPathStyle.posix) ??
            toHostPath(value, HostPathStyle.windows)
      : toHostPath(value, style);
  return converted != null && validateCheckoutPath(converted) == null
      ? converted
      : null;
}

/// Accepts a canonical absolute host path in either style, never a whole
/// drive or filesystem.
String? validateCheckoutPath(String? value) => isCanonicalHostPath(value ?? '')
    ? null
    : 'Use a canonical absolute path with no traversal or trailing slash';

/// One checkout folder being entered: chosen in the host's folder picker
/// while the instance can browse, typed otherwise. Whether it can browse is
/// settled when the dialog opens.
class CheckoutPath {
  CheckoutPath(this.store, this.instanceId)
    : browsable = canBrowseFolders(store.instance(instanceId)),
      style = store.hostStyle(instanceId);
  final RemoteStore store;
  final String instanceId;
  final bool browsable;

  /// The host's path style for typed paths, as known or inferred.
  final HostPathStyle? style;

  /// The folder chosen in the picker.
  String? chosen;

  /// The typed path, converted to the host's style when it is read.
  final typed = TextEditingController();

  /// The canonical host path to record, or null when there is none yet.
  String? get value => browsable ? chosen : hostCheckoutPath(typed.text, style);

  void dispose() => typed.dispose();
}

/// The form field for a [CheckoutPath]: "Choose folder" opens the host's
/// folder picker and the chosen path then reads back with "Change"; without
/// the picker, a text field that converts what is typed to the host's style.
class CheckoutFolderField extends StatefulWidget {
  const CheckoutFolderField({
    required this.checkout,
    required this.label,
    super.key,
  });
  final CheckoutPath checkout;
  final String label;
  @override
  State<CheckoutFolderField> createState() => _CheckoutFolderFieldState();
}

class _CheckoutFolderFieldState extends State<CheckoutFolderField> {
  final typedField = GlobalKey<FormFieldState<String>>();
  @override
  Widget build(BuildContext context) {
    final checkout = widget.checkout;
    final style = checkout.style;
    if (!checkout.browsable) {
      final converted = hostCheckoutPath(checkout.typed.text, style);
      return TextFormField(
        key: typedField,
        controller: checkout.typed,
        autocorrect: false,
        enableSuggestions: false,
        keyboardType: TextInputType.url,
        decoration: InputDecoration(
          labelText: widget.label,
          hintText: style == HostPathStyle.windows
              ? r'C:\allowed\work\repo'
              : '/allowed/work/repo',
          // Say what is recorded when it differs from what was typed.
          helperText:
              converted != null && converted != checkout.typed.text.trim()
              ? 'Saved as $converted'
              : null,
        ),
        onChanged: (_) => setState(() {
          // A shown error goes as soon as the path is usable.
          if (typedField.currentState?.hasError ?? false) {
            typedField.currentState!.validate();
          }
        }),
        validator: (value) => hostCheckoutPath(value, style) == null
            ? 'Use an absolute path on this host, like ${hostPathExample(style)}.'
            : null,
      );
    }
    final colors = HarnessColors.of(context);
    final text = Theme.of(context).textTheme;
    return FormField<String>(
      initialValue: checkout.chosen,
      validator: (value) => value != null && validateCheckoutPath(value) == null
          ? null
          : 'Choose the existing checkout folder.',
      builder: (field) {
        final value = field.value;
        Future<void> choose() async {
          final picked = await showFolderChooser(
            context,
            store: checkout.store,
            instanceId: checkout.instanceId,
            initial: value,
          );
          if (picked == null || !mounted) return;
          checkout.chosen = picked;
          field.didChange(picked);
          if (field.hasError) field.validate();
        }

        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.label,
              style: text.labelMedium?.copyWith(color: colors.secondary),
            ),
            const SizedBox(height: Space.xs),
            Resize(
              child: Swap(
                child: value == null
                    ? OutlinedButton(
                        key: const ValueKey('choose'),
                        onPressed: choose,
                        child: const Text('Choose folder'),
                      )
                    : Row(
                        key: ValueKey(value),
                        children: [
                          Icon(
                            Icons.folder_outlined,
                            size: 20,
                            color: colors.secondary,
                          ),
                          const SizedBox(width: Space.m),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  hostPathName(value),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: text.bodyMedium,
                                ),
                                Text(
                                  value,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: text.bodySmall,
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: Space.s),
                          TextButton(
                            onPressed: choose,
                            child: const Text('Change'),
                          ),
                        ],
                      ),
              ),
            ),
            Reveal(
              padding: const EdgeInsets.only(top: Space.xs),
              child: field.errorText == null
                  ? null
                  : Text(
                      field.errorText!,
                      style: text.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
            ),
          ],
        );
      },
    );
  }
}

class GithubMappingsDialog extends StatefulWidget {
  const GithubMappingsDialog({
    required this.repositories,
    required this.store,
    required this.instanceId,
    super.key,
  });
  final List<JsonMap> repositories;
  final RemoteStore store;
  final String instanceId;
  @override
  State<GithubMappingsDialog> createState() => _GithubMappingsDialogState();
}

class _GithubMappingsDialogState extends State<GithubMappingsDialog> {
  final form = GlobalKey<FormState>();
  late final paths = [
    for (final _ in widget.repositories)
      CheckoutPath(widget.store, widget.instanceId),
  ];
  @override
  void dispose() {
    for (final p in paths) {
      p.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => plainDialog(
    title: const Text('Bind existing checkouts'),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Form(
          key: form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'One existing host path per repository. Access is rechecked when saved; nothing is cloned, fetched or changed.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (paths.isNotEmpty && !paths.first.browsable) ...[
                const SizedBox(height: Space.xs),
                Text(
                  folderPickerUnavailable,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              for (var i = 0; i < paths.length; i++)
                Padding(
                  padding: const EdgeInsets.only(top: Space.m),
                  child: CheckoutFolderField(
                    checkout: paths[i],
                    label: widget.repositories[i]['fullName'].toString(),
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
    actions: [
      FilledButton(
        onPressed: () {
          if (form.currentState!.validate()) {
            Navigator.pop(context, <JsonMap>[
              for (var i = 0; i < paths.length; i++)
                {
                  'source': 'github',
                  'repositoryId': widget.repositories[i]['id'],
                  'installationId': widget.repositories[i]['installationId'],
                  'page': widget.repositories[i]['page'],
                  'installationPage':
                      widget.repositories[i]['installationPage'],
                  'localPath': paths[i].value,
                },
            ]);
          }
        },
        child: const Text('Save references'),
      ),
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
    ],
  );
}

Future<void> showRepositoryPreview(
  BuildContext context,
  List<RepositoryReference> references,
) => showDialog<void>(
  context: context,
  builder: (context) => plainDialog(
    title: const Text('Message context preview'),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Only this verified metadata is added, as untrusted data, and each send rechecks the checkout. No tokens, file contents or executable commands are included.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: Space.l),
            CodeBlock(
              pretty({
                'repositories': references
                    .map((r) => r.contextPreview)
                    .toList(),
              }),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Close'),
      ),
    ],
  ),
);
