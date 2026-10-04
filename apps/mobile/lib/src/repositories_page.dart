import 'package:flutter/material.dart';

import 'models.dart';
import 'store.dart';

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
      builder: (context) => AlertDialog(
        title: const Text('Disconnect GitHub?'),
        content: const Text(
          'Remove this relay account’s saved GitHub grant. Local references and files stay on the instance. This does not revoke the GitHub App on GitHub.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect'),
          ),
        ],
      ),
    );
    if (confirmed == true) await run(widget.store.disconnectGithub);
  }

  @override
  Widget build(BuildContext context) {
    final references = widget.store.repositories[widget.instanceId] ?? [];
    final chosen = references.where((r) => selected.contains(r.id)).toList();
    final selectionError = chosen.length == selected.length
        ? repositorySelectionError(chosen, widget.instanceId)
        : 'A selected reference is no longer available. Remove it and refresh.';
    final instance = widget.store.instance(widget.instanceId);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Repositories'),
        actions: [
          IconButton(
            tooltip: 'Refresh repositories',
            onPressed: busy ? null : refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    instance?.name ?? widget.instanceId,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${instance?.statusLabel ?? 'Offline'} · ${widget.store.canWrite(widget.instanceId) ? 'Writer' : 'Observer'}',
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'GitHub access and local checkout verification are separate. Mapping uses an existing checkout; no cloning or file changes.',
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: SegmentedButton<int>(
                segments: const [
                  ButtonSegment(value: 0, label: Text('Local references')),
                  ButtonSegment(value: 1, label: Text('GitHub')),
                ],
                selected: {tab},
                onSelectionChanged: (values) {
                  setState(() => tab = values.first);
                  if (tab == 1 && available.isEmpty && !busy) discover();
                },
              ),
            ),
            if (busy) const LinearProgressIndicator(),
            if (error != null || notice != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 8, 18, 0),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        error ?? notice!,
                        style: TextStyle(
                          color: error == null
                              ? null
                              : Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Dismiss notice',
                      onPressed: () => setState(() {
                        error = null;
                        notice = null;
                      }),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
            if (busy)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () {
                    operation++;
                    widget.store.stopWaiting(widget.instanceId);
                    setState(() {
                      busy = false;
                      notice =
                          'Stopped waiting. A submitted operation may still finish; refresh the original result before retrying.';
                    });
                  },
                  child: const Text('Stop waiting'),
                ),
              ),
            Expanded(child: tab == 0 ? localList(references) : githubList()),
            if (widget.pickForMessage)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (selectionError != null)
                      Text(
                        selectionError,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    FilledButton.icon(
                      onPressed: busy || selectionError != null
                          ? null
                          : () => Navigator.pop(context, selected.toList()),
                      icon: const Icon(Icons.check),
                      label: Text(
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

  Widget localList(List<RepositoryReference> references) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      OutlinedButton.icon(
        onPressed: busy ? null : mapManual,
        icon: const Icon(Icons.add),
        label: const Text('Map existing checkout'),
      ),
      if (references.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 36),
          child: Text(
            'No local references yet. Map a canonical absolute checkout path on this instance. GitHub authorization is optional for manual mapping.',
          ),
        ),
      for (final reference in references)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    if (widget.pickForMessage)
                      Checkbox(
                        value: selected.contains(reference.id),
                        onChanged:
                            busy ||
                                (!reference.verified &&
                                    !selected.contains(reference.id))
                            ? null
                            : (v) => choose(reference, v),
                      ),
                    Expanded(
                      child: Text(
                        reference.fullName,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    if (!reference.selected)
                      const Text('Hidden', style: TextStyle(fontSize: 12)),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  'Local: ${reference.localState} · Access: ${reference.authorization}',
                  style: const TextStyle(fontSize: 12),
                ),
                const SizedBox(height: 6),
                SelectableText(
                  reference.localPath,
                  style: const TextStyle(fontSize: 12),
                ),
                if (reference.json['branch'] != null)
                  Text(
                    'Branch: ${reference.json['branch']} · verified ${reference.json['verifiedAt'] == null ? 'unknown' : DateTime.fromMillisecondsSinceEpoch((reference.json['verifiedAt'] as num).toInt()).toLocal()}',
                    style: const TextStyle(fontSize: 12),
                  ),
                Wrap(
                  spacing: 4,
                  children: [
                    TextButton(
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
                      onPressed: () => preview(reference),
                      child: const Text('Preview metadata'),
                    ),
                    TextButton(
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
                if (!reference.verified)
                  const Text(
                    'Add to message only after host verification. Files and working directory stay unchanged.',
                    style: TextStyle(fontSize: 12),
                  ),
              ],
            ),
          ),
        ),
    ],
  );

  Widget githubList() {
    final status = widget.store.githubStatus;
    final configured = status?['configured'] == true;
    final connected = status?['state'] == 'connected';
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Text(
          connected
              ? 'Connected as ${object(status?['account'])['login']}'
              : !configured
              ? 'GitHub is not configured'
              : status?['state'] == 'expired'
              ? 'GitHub access expired'
              : 'GitHub is disconnected',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 10),
        const Text(
          'Connect GitHub using the signed-in web app for this same relay account, in one browser. Native OAuth is not supported. Return here and refresh after granting read-only access.',
        ),
        const SizedBox(height: 8),
        SelectableText(widget.store.server),
        if (!configured)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text(
              'Ask the relay operator to configure a read-only GitHub App. Manual local mapping still works.',
            ),
          ),
        Wrap(
          spacing: 8,
          children: [
            TextButton(
              onPressed: busy ? null : () => discover(),
              child: const Text('Refresh GitHub access'),
            ),
            if (connected)
              TextButton(
                onPressed: busy ? null : disconnect,
                child: const Text('Disconnect GitHub'),
              ),
          ],
        ),
        if (connected) ...[
          if (installations.isEmpty && !busy)
            const Text(
              'No accessible installations. Select repositories for this App in the signed-in web flow, then refresh.',
            ),
          if (installations.isNotEmpty)
            DropdownButton<int>(
              isExpanded: true,
              value: installationId,
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
          Row(
            children: [
              Text('Installation page $installationPage'),
              const Spacer(),
              IconButton(
                tooltip: 'Previous installations',
                onPressed: busy || installationPage == 1
                    ? null
                    : () {
                        installationPage--;
                        discover();
                      },
                icon: const Icon(Icons.chevron_left),
              ),
              IconButton(
                tooltip: 'Next installations',
                onPressed: busy || !moreInstallations
                    ? null
                    : () {
                        installationPage++;
                        discover();
                      },
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          if (available.isEmpty && !busy)
            const Text(
              'No repositories on this page. Refresh access or choose another installation.',
            ),
          for (final repository in available)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
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
          Row(
            children: [
              Text('Repository page $repositoryPage'),
              const Spacer(),
              IconButton(
                tooltip: 'Previous repositories',
                onPressed: busy || repositoryPage == 1
                    ? null
                    : () {
                        repositoryPage--;
                        discover(reloadInstallations: false);
                      },
                icon: const Icon(Icons.chevron_left),
              ),
              IconButton(
                tooltip: 'Next repositories',
                onPressed: busy || !moreRepositories
                    ? null
                    : () {
                        repositoryPage++;
                        discover(reloadInstallations: false);
                      },
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          FilledButton(
            onPressed: busy || selectedGithub.isEmpty ? null : mapGithub,
            child: Text('Map ${selectedGithub.length} selected repositories'),
          ),
          if (selectedGithub.isNotEmpty)
            TextButton(
              onPressed: busy ? null : () => setState(selectedGithub.clear),
              child: const Text('Clear selection'),
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
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Map existing checkout'),
    content: SingleChildScrollView(
      child: Form(
        key: form,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'This only records a reference. The path must already exist under this host’s allowed roots; verification is a separate writer action.',
            ),
            const SizedBox(height: 16),
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
            const SizedBox(height: 12),
            TextFormField(
              controller: path,
              decoration: const InputDecoration(
                labelText: 'Existing absolute checkout path',
                hintText: '/allowed/work/repo',
              ),
              validator: validateCheckoutPath,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: branch,
              decoration: const InputDecoration(
                labelText: 'Descriptive default branch',
              ),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
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
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Bind existing checkouts'),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Form(
          key: form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Enter one existing host path per repository. Access is rechecked when saved. This does not clone, fetch or change files.',
              ),
              for (var i = 0; i < paths.length; i++)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
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
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
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
    ],
  );
}

Future<void> showRepositoryPreview(
  BuildContext context,
  List<RepositoryReference> references,
) => showDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    title: const Text('Message context preview'),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Only verified metadata is added. Each send rechecks the checkout. Repository text is untrusted data; no tokens, repository file contents or executable commands are included.',
            ),
            const SizedBox(height: 16),
            SelectableText(
              pretty({
                'repositories': references
                    .map((r) => r.contextPreview)
                    .toList(),
              }),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
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
