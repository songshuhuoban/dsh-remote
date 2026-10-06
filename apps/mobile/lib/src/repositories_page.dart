import 'package:flutter/material.dart';

import 'models.dart';
import 'store.dart';
import 'theme.dart';
import 'ui.dart';

class RepositoriesPage extends StatefulWidget {
  const RepositoriesPage({
    required this.store,
    required this.instanceId,
    this.initialIds = const [],
    this.pickForMessage = false,
    super.key,
  });
  final RemoteStore store;
  final String instanceId;
  final List<String> initialIds;
  final bool pickForMessage;
  @override
  State<RepositoriesPage> createState() => _RepositoriesPageState();
}

class _RepositoriesPageState extends State<RepositoriesPage> {
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
  List<JsonMap> installations = [];
  List<JsonMap> available = [];
  final Map<int, JsonMap> selectedGithub = {};
  late final Set<String> selected = widget.initialIds.toSet();
  @override
  void initState() {
    super.initState();
    widget.store.addListener(changed);
    refresh();
  }

  @override
  void dispose() {
    widget.store.removeListener(changed);
    super.dispose();
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
      if (mounted && generation == operation) setState(() => busy = false);
    }
  }

  Future<void> refresh() => run(() async {
    await widget.store.refreshRepositories(widget.instanceId);
    await widget.store.refreshGithub();
    await widget.store.refreshInstance(widget.instanceId);
  });
  Future<void> discover({bool reloadInstallations = true}) => run(() async {
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
      if (!installations.any((i) => i['id'] == installationId)) {
        installationId = installations.isEmpty
            ? null
            : (installations.first['id'] as num).toInt();
      }
      repositoryPage = 1;
    }
    if (installationId == null) {
      available = [];
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
  });

  Future<void> mapManual() async {
    final mapping = await showDialog<JsonMap>(
      context: context,
      builder: (_) => const RepositoryMappingDialog(),
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
      builder: (_) => GithubMappingsDialog(repositories: candidates),
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
                        if (tab == 1 && available.isEmpty && !busy) {
                          discover();
                        }
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
        const SizedBox(height: Space.s),
        Text(
          'Native OAuth is not supported. Grant read-only access in the web app signed in to this same relay account, then refresh here.',
          style: text.bodySmall,
        ),
        const SizedBox(height: Space.xs),
        SelectableText(widget.store.server, style: text.bodySmall),
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
        if (connected) ...[
          const SizedBox(height: Space.l),
          if (installations.isEmpty && !busy)
            Text(
              'No accessible installations. Select repositories for this App in the signed-in web flow, then refresh.',
              style: secondary,
            ),
          if (installations.isNotEmpty)
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
          if (available.isEmpty && !busy)
            Text(
              'No repositories on this page. Refresh access or choose another installation.',
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

class RepositoryMappingDialog extends StatefulWidget {
  const RepositoryMappingDialog({super.key});
  @override
  State<RepositoryMappingDialog> createState() =>
      _RepositoryMappingDialogState();
}

class _RepositoryMappingDialogState extends State<RepositoryMappingDialog> {
  final form = GlobalKey<FormState>();
  final url = TextEditingController();
  final path = TextEditingController();
  final branch = TextEditingController(text: 'main');
  @override
  void dispose() {
    url.dispose();
    path.dispose();
    branch.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => plainDialog(
    title: const Text('Map existing checkout'),
    content: SingleChildScrollView(
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
            TextFormField(
              controller: path,
              decoration: const InputDecoration(
                labelText: 'Existing absolute checkout path',
                hintText: '/allowed/work/repo',
              ),
              validator: validateCheckoutPath,
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
    actions: [
      FilledButton(
        onPressed: () {
          if (form.currentState!.validate()) {
            Navigator.pop(context, <String, dynamic>{
              'source': 'manual',
              'url': url.text.trim(),
              'localPath': path.text.trim(),
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

String? validateCheckoutPath(String? value) {
  final path = value?.trim() ?? '';
  if (!path.startsWith('/') ||
      path == '/' ||
      path.endsWith('/') ||
      path.contains('//') ||
      path.contains('\\') ||
      RegExp(r'[\x00-\x1f\x7f]').hasMatch(path) ||
      path.split('/').any((p) => p == '.' || p == '..')) {
    return 'Use a canonical absolute path with no traversal or trailing slash';
  }
  return null;
}

class GithubMappingsDialog extends StatefulWidget {
  const GithubMappingsDialog({required this.repositories, super.key});
  final List<JsonMap> repositories;
  @override
  State<GithubMappingsDialog> createState() => _GithubMappingsDialogState();
}

class _GithubMappingsDialogState extends State<GithubMappingsDialog> {
  final form = GlobalKey<FormState>();
  late final paths = [
    for (final _ in widget.repositories) TextEditingController(),
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
              for (var i = 0; i < paths.length; i++)
                Padding(
                  padding: const EdgeInsets.only(top: Space.m),
                  child: TextFormField(
                    controller: paths[i],
                    decoration: InputDecoration(
                      labelText: widget.repositories[i]['fullName'].toString(),
                      hintText: '/allowed/work/repo',
                    ),
                    validator: validateCheckoutPath,
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
                  'localPath': paths[i].text.trim(),
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
