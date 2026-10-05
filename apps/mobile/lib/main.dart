import 'dart:async';
import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'src/models.dart';
import 'src/credentials.dart';
import 'src/store.dart';
import 'src/theme.dart';
import 'src/repositories_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const DshRemoteApp());
}

class DshRemoteApp extends StatefulWidget {
  const DshRemoteApp({
    this.restoreSession = true,
    this.credentials,
    this.store,
    this.themeMode = ThemeMode.system,
    super.key,
  });
  final bool restoreSession;
  final CredentialStore? credentials;
  final RemoteStore? store;
  final ThemeMode themeMode;
  @override
  State<DshRemoteApp> createState() => _DshRemoteAppState();
}

class _DshRemoteAppState extends State<DshRemoteApp> {
  late final RemoteStore store =
      widget.store ??
      RemoteStore(
        credentials: widget.credentials ?? const SecureCredentialStore(),
      );
  @override
  void initState() {
    super.initState();
    if (widget.restoreSession) store.restore();
  }

  @override
  void dispose() {
    if (widget.store == null) store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) => MaterialApp(
      key: ValueKey(store.user?['id']),
      title: 'DSH Remote',
      debugShowCheckedModeBanner: false,
      theme: harnessTheme(Brightness.light),
      darkTheme: harnessTheme(Brightness.dark),
      themeMode: widget.themeMode,
      home: store.signedIn ? FleetPage(store: store) : SignInPage(store: store),
    ),
  );
}

class SignInPage extends StatefulWidget {
  const SignInPage({required this.store, super.key});
  final RemoteStore store;
  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final form = GlobalKey<FormState>();
  final server = TextEditingController(
    text: const String.fromEnvironment(
      'RELAY_URL',
      defaultValue: 'http://127.0.0.1:8787',
    ),
  );
  final email = TextEditingController();
  final password = TextEditingController();
  final name = TextEditingController(text: 'My mobile');
  bool register = false;
  bool obscure = true;
  @override
  void dispose() {
    for (final c in [server, email, password, name]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> submit() async {
    if (form.currentState?.validate() != true) return;
    await widget.store.authenticate(
      server: server.text,
      email: email.text,
      password: password.text,
      deviceName: name.text,
      register: register,
    );
    if (mounted && widget.store.signedIn) password.clear();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Form(
              key: form,
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(
                      Icons.terminal_rounded,
                      size: 56,
                      color: Color(0xff4176e6),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'Your agents. Anywhere.',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 10),
                    const Text(
                      'Connect to your DSH relay. View every instance, or take control from this device.',
                    ),
                    const SizedBox(height: 32),
                    TextFormField(
                      controller: server,
                      decoration: const InputDecoration(
                        labelText: 'Relay server',
                        hintText: 'https://relay.example.com',
                      ),
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      validator: requiredValue,
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: email,
                      decoration: const InputDecoration(labelText: 'Email'),
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.username],
                      autocorrect: false,
                      validator: requiredValue,
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: password,
                      obscureText: obscure,
                      autofillHints: [
                        register
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      decoration: InputDecoration(
                        labelText: 'Password',
                        suffixIcon: IconButton(
                          tooltip: obscure ? 'Show password' : 'Hide password',
                          onPressed: () => setState(() => obscure = !obscure),
                          icon: Icon(
                            obscure ? Icons.visibility : Icons.visibility_off,
                          ),
                        ),
                      ),
                      validator: (v) => (v?.length ?? 0) < 8 && register
                          ? 'Use at least 8 characters'
                          : requiredValue(v),
                      onFieldSubmitted: (_) => submit(),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: name,
                      decoration: const InputDecoration(
                        labelText: 'Controller name',
                      ),
                      validator: requiredValue,
                    ),
                    const SizedBox(height: 20),
                    if (widget.store.error != null)
                      ErrorNotice(widget.store.error!),
                    FilledButton(
                      onPressed: widget.store.busy ? null : submit,
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: widget.store.busy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : Text(register ? 'Create account' : 'Sign in'),
                      ),
                    ),
                    if (widget.store.busy)
                      TextButton(
                        onPressed: widget.store.cancelAuthentication,
                        child: const Text('Cancel sign-in'),
                      ),
                    TextButton(
                      onPressed: widget.store.busy
                          ? null
                          : () => setState(() => register = !register),
                      child: Text(
                        register
                            ? 'Already have an account? Sign in'
                            : 'Create an account',
                      ),
                    ),
                    TextButton(
                      onPressed: widget.store.busy
                          ? null
                          : widget.store.restore,
                      child: const Text('Restore saved session'),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'Your session is saved in device secure storage and restored on restart. Your password is never saved. Use HTTPS for remote servers.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

String? requiredValue(String? value) =>
    value == null || value.trim().isEmpty ? 'Required' : null;

class FleetPage extends StatefulWidget {
  const FleetPage({required this.store, super.key});
  final RemoteStore store;
  @override
  State<FleetPage> createState() => _FleetPageState();
}

class _FleetPageState extends State<FleetPage> {
  int tab = 0;
  bool creating = false;
  Future<void> createInstance() async {
    final value = await inputDialog(
      context,
      title: 'Add a DSH instance',
      label: 'Instance name',
    );
    if (value == null || !mounted) return;
    setState(() => creating = true);
    try {
      final result = await widget.store.createInstance(value);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => AlertDialog(
          title: const Text('Connect your local DSH'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Save this connector token now. It is shown only once. Save the token in an owner-only file (0600) inside a private directory (0700) on the DSH machine. Configure connectorTokenFile with that absolute path and the relay URL.',
                ),
                const SizedBox(height: 16),
                SelectableText(
                  result['connectorToken'].toString(),
                  style: const TextStyle(fontFamily: 'monospace'),
                ),
                const SizedBox(height: 12),
                SelectableText(
                  'Instance: ${object(result['instance'])['id']}\nRelay: ${widget.store.server}',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(
                  ClipboardData(text: result['connectorToken'].toString()),
                );
                if (context.mounted) {
                  message(
                    context,
                    'Token copied. Clear your clipboard after configuring the connector.',
                  );
                }
              },
              child: const Text('Copy token'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Saved'),
            ),
          ],
        ),
      );
    } catch (e) {
      if (mounted) message(context, e.toString());
    } finally {
      if (mounted) setState(() => creating = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('deepseek harness'),
      actions: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Center(
            child: StatusPill(
              widget.store.connection,
              good: widget.store.connection == 'Live',
            ),
          ),
        ),
        IconButton(
          tooltip: 'Refresh',
          onPressed: widget.store.refresh,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: Column(
      children: [
        if (widget.store.error != null || widget.store.journalError != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: ErrorNotice(
              widget.store.error ?? widget.store.journalError!,
            ),
          ),
        Expanded(
          child: [instancesView(), commandsView(), controllersView()][tab],
        ),
      ],
    ),
    floatingActionButton: tab == 0
        ? FloatingActionButton.extended(
            onPressed: creating ? null : createInstance,
            icon: creating
                ? const CircularProgressIndicator()
                : const Icon(Icons.add),
            label: const Text('Add instance'),
          )
        : null,
    drawer: Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.all(20),
              child: Text(
                'deepseek harness',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w400),
              ),
            ),
            for (final entry in [
              (0, Icons.dns_outlined, 'Instances'),
              (1, Icons.receipt_long_outlined, 'Commands'),
              (2, Icons.devices_outlined, 'Account & devices'),
            ])
              ListTile(
                selected: tab == entry.$1,
                leading: Icon(entry.$2),
                title: Text(entry.$3),
                onTap: () {
                  Navigator.pop(context);
                  setState(() => tab = entry.$1);
                },
              ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(
                widget.store.user?['email']?.toString() ?? '',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
      ),
    ),
  );
  Widget instancesView() => RefreshIndicator(
    onRefresh: widget.store.refresh,
    child: ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 100),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        Text('Your fleet', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 4),
        const Text(
          'One active controller per instance. Every other device can follow along.',
        ),
        const SizedBox(height: 24),
        if (widget.store.instances.isEmpty)
          const EmptyState(
            icon: Icons.dns_outlined,
            title: 'No instances yet',
            detail:
                'Add an instance and pair its local connector to get started.',
          ),
        for (final instance in widget.store.instances)
          Card(
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) =>
                      InstancePage(store: widget.store, id: instance.id),
                ),
              ),
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.terminal),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            instance.name,
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                        StatusPill(instance.statusLabel, good: instance.online),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text(
                      widget.store.canWrite(instance.id)
                          ? 'You have control'
                          : instance.lease != null && !instance.lease!.expired
                          ? 'In use · tap to view'
                          : 'No active controller',
                    ),
                    const SizedBox(height: 4),
                    Text(
                      instance.id,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    ),
  );
  Widget commandsView() => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Text(
        'Command history',
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      if (widget.store.journalError != null)
        ErrorNotice(widget.store.journalError!),
      TextButton.icon(
        onPressed: widget.store.restoreCommandJournal,
        icon: const Icon(Icons.lock_reset),
        label: const Text('Reload saved command journal'),
      ),
      const SizedBox(height: 8),
      const Text(
        'This device’s commands and restored unresolved operations. Unknown outcomes are never automatically retried.',
      ),
      const SizedBox(height: 20),
      if (widget.store.commands.isEmpty)
        const EmptyState(
          icon: Icons.receipt_long,
          title: 'Nothing sent yet',
          detail:
              'Commands and their server-confirmed status will appear here.',
        ),
      for (final command in widget.store.commands.values.toList().reversed)
        Card(
          child: ExpansionTile(
            title: Text(command.json['action']?.toString() ?? command.id),
            subtitle: Text(command.status),
            childrenPadding: const EdgeInsets.all(16),
            children: [
              SelectableText(pretty(command.json)),
              TextButton.icon(
                onPressed: () async {
                  try {
                    await widget.store.checkCommand(command.id);
                  } catch (e) {
                    if (mounted) message(context, e.toString());
                  }
                },
                icon: const Icon(Icons.refresh),
                label: const Text('Check status'),
              ),
            ],
          ),
        ),
    ],
  );
  Widget controllersView() => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Text(
        'Connected identity',
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 16),
      ListTile(
        leading: const Icon(Icons.person_outline),
        title: Text(widget.store.user?['email']?.toString() ?? ''),
        subtitle: Text(widget.store.server),
      ),
      const Divider(),
      const Text(
        'Sign in on another device with a distinct controller name to add it to your account.',
      ),
      for (final controller in widget.store.controllers)
        ListTile(
          leading: Icon(
            controller['id'] == widget.store.controllerId
                ? Icons.smartphone
                : Icons.devices,
          ),
          title: Text(controller['name']?.toString() ?? 'Controller'),
          subtitle: Text(
            controller['id'] == widget.store.controllerId
                ? 'This device'
                : controller['id'].toString(),
          ),
          trailing: controller['active'] == true
              ? IconButton(
                  tooltip: 'Revoke ${controller['name']}',
                  icon: const Icon(Icons.logout),
                  onPressed: () async {
                    final id = controller['id'].toString();
                    if (!await confirmDialog(
                      context,
                      'Revoke this device?',
                      'Revoke ${controller['name']} ($id). Its current login loses access and writer control. Revoke this device to sign out here.',
                      'Revoke device',
                    )) {
                      return;
                    }
                    try {
                      await widget.store.api!.request(
                        'POST',
                        'api/controllers/${Uri.encodeComponent(id)}/revoke',
                        {'controllerId': widget.store.controllerId},
                      );
                      if (id == widget.store.controllerId) {
                        await widget.store.signOut(revoke: false);
                      } else {
                        await widget.store.refresh();
                      }
                    } catch (e) {
                      if (mounted) message(context, e.toString());
                    }
                  },
                )
              : const Text('Revoked'),
        ),
      const SizedBox(height: 24),
      OutlinedButton.icon(
        onPressed: () async {
          final confirm = await confirmDialog(
            context,
            'Sign out?',
            'Your secure session will be removed and revoked. Any writer lease stops renewing and expires within 30 seconds.',
            'Sign out',
          );
          if (confirm) await widget.store.signOut();
        },
        icon: const Icon(Icons.logout),
        label: const Text('Sign out'),
      ),
    ],
  );
}

class InstancePage extends StatefulWidget {
  const InstancePage({required this.store, required this.id, super.key});
  final RemoteStore store;
  final String id;
  @override
  State<InstancePage> createState() => _InstancePageState();
}

class _InstancePageState extends State<InstancePage> {
  bool busy = false;
  int operationEpoch = 0;
  String? error;
  List<JsonMap> sessions = [];
  @override
  void initState() {
    super.initState();
    widget.store.addListener(changed);
    load();
  }

  @override
  void dispose() {
    widget.store.removeListener(changed);
    super.dispose();
  }

  void changed() {
    if (mounted) setState(() {});
  }

  Future<void> run(Future<void> Function() operation) async {
    if (busy) return;
    final epoch = ++operationEpoch;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await operation();
    } catch (e) {
      if (mounted && epoch == operationEpoch) {
        setState(() => error = e.toString());
      }
    } finally {
      if (mounted && epoch == operationEpoch) setState(() => busy = false);
    }
  }

  Future<void> load() => run(() async {
    final current = await widget.store.refreshInstance(widget.id);
    if (!current.online) return;
    final result = await widget.store.command(widget.id, 'session.list', {});
    final raw = result is List ? result : object(result)['items'];
    if (mounted) {
      setState(() => sessions = (raw is List ? raw : []).map(object).toList());
    }
  });
  Future<void> control() async {
    final instance = widget.store.instance(widget.id);
    if (instance == null) return;
    if (widget.store.canWrite(instance.id)) {
      await run(() => widget.store.release(widget.id));
      return;
    }
    final takeover = instance.lease != null && !instance.lease!.expired;
    if (takeover &&
        !await confirmDialog(
          context,
          'Take over this instance?',
          'The current writer will lose control. Their already-running operation may continue; use Cancel separately if needed.',
          'Take over',
        )) {
      return;
    }
    await run(() => widget.store.acquire(widget.id, takeover: takeover));
  }

  Future<void> createSession() async {
    final confirmed = await confirmDialog(
      context,
      'New session?',
      'Create a session in the connector’s configured default workspace.',
      'Create session',
    );
    if (!confirmed || !mounted) return;
    await run(() async {
      await widget.store.command(widget.id, 'session.create', {
        'sessionId': newId(),
      });
    });
    if (error == null) await load();
  }

  @override
  Widget build(BuildContext context) {
    final instance = widget.store.instance(widget.id);
    if (instance == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: Text('Instance no longer available.')),
      );
    }
    final owned = widget.store.canWrite(instance.id);
    return Scaffold(
      appBar: AppBar(
        title: Text(instance.name),
        actions: [
          IconButton(
            tooltip: 'Repositories',
            icon: const Icon(Icons.account_tree_outlined),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) => RepositoriesPage(
                  store: widget.store,
                  instanceId: widget.id,
                ),
              ),
            ),
          ),
          IconButton(
            tooltip: 'Refresh instance status',
            onPressed: busy ? null : load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        StatusPill(instance.statusLabel, good: instance.online),
                        const SizedBox(width: 12),
                        Text(owned ? 'Writer' : 'Viewer'),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      instance.lastSeenAt == null
                          ? 'No heartbeat observed yet'
                          : 'Last seen: ${instance.lastSeenAt!.toLocal()}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      owned
                          ? 'You control this instance. Keep the app open to renew your lease.'
                          : 'Read sessions freely. Take control to send prompts or change settings.',
                    ),
                    const SizedBox(height: 12),
                    FilledButton.tonalIcon(
                      onPressed:
                          busy ||
                              !instance.online ||
                              widget.store.connection != 'Live' ||
                              instance.lease?.pending == true
                          ? null
                          : control,
                      icon: Icon(
                        owned ? Icons.lock_open : Icons.gamepad_outlined,
                      ),
                      label: Text(
                        instance.lease?.pending == true
                            ? 'Waiting for connector…'
                            : owned
                            ? 'Release control'
                            : instance.lease != null && !instance.lease!.expired
                            ? 'Take over control'
                            : 'Take control',
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (busy)
            Row(
              children: [
                const Expanded(child: LinearProgressIndicator()),
                TextButton(
                  onPressed: () {
                    operationEpoch++;
                    widget.store.stopWaiting(widget.id);
                    widget.store.abandonControl(widget.id);
                    setState(() {
                      busy = false;
                      error =
                          'Stopped waiting. Refresh status and query any submitted command before trying again.';
                    });
                  },
                  child: const Text('Stop waiting'),
                ),
              ],
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: ErrorNotice(
                error!,
                onDismiss: () => setState(() => error = null),
              ),
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 100),
                children: [
                  Text(
                    'Sessions',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 12),
                  if (sessions.isEmpty && !busy)
                    const EmptyState(
                      icon: Icons.chat_bubble_outline,
                      title: 'No sessions loaded',
                      detail:
                          'Refresh an online instance, or take control and create a session.',
                    ),
                  for (final session in sessions)
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.chat_bubble_outline),
                        title: Text(
                          session['title']?.toString() ??
                              session['cwd']?.toString() ??
                              sessionId(session),
                        ),
                        subtitle: Text(sessionId(session)),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.push(
                          context,
                          MaterialPageRoute<void>(
                            builder: (_) => SessionPage(
                              store: widget.store,
                              instanceId: widget.id,
                              sessionId: sessionId(session),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: owned && !busy ? createSession : null,
        icon: const Icon(Icons.add),
        label: const Text('New session'),
      ),
    );
  }
}

String sessionId(JsonMap session) =>
    (session['sessionId'] ?? session['id'] ?? session['sessionKey'] ?? '')
        .toString();

class SessionPage extends StatefulWidget {
  const SessionPage({
    required this.store,
    required this.instanceId,
    required this.sessionId,
    super.key,
  });
  final RemoteStore store;
  final String instanceId;
  final String sessionId;
  @override
  State<SessionPage> createState() => _SessionPageState();
}

class _SessionPageState extends State<SessionPage> {
  final prompt = TextEditingController();
  final transcriptScroll = ScrollController();
  bool autoFollow = true;
  bool busy = false;
  String? error;
  Object? snapshot;
  Object? projections;
  List<JsonMap> history = [];
  int historyCursor = -1;
  bool hasMoreHistory = false;
  String previousConnection = '';
  int tab = 0;
  String promptMode = 'queue';
  final List<JsonMap> attachments = [];
  final List<String> referenceIds = [];
  int operation = 0;
  String get draftKey => '${widget.instanceId}:${widget.sessionId}';
  void saveDraft() {
    if (!widget.store.signedIn) return;
    widget.store.drafts[draftKey] = {
      'text': prompt.text,
      'mode': promptMode,
      'references': List<String>.of(referenceIds),
      'attachments': List<JsonMap>.of(attachments),
    };
  }

  List<RepositoryReference> get references => [
    for (final id in referenceIds)
      (widget.store.repositories[widget.instanceId] ?? []).firstWhere(
        (r) => r.id == id,
        orElse: () => RepositoryReference({
          'id': id,
          'instanceId': widget.instanceId,
          'fullName': 'Unavailable reference',
          'localState': 'stale',
        }),
      ),
  ];

  @override
  void initState() {
    super.initState();
    widget.store.addListener(changed);
    final draft = widget.store.drafts[draftKey];
    if (draft != null) {
      prompt.text = draft['text']?.toString() ?? '';
      promptMode = draft['mode']?.toString() ?? 'queue';
      referenceIds.addAll(
        (draft['references'] as List? ?? []).map((v) => v.toString()),
      );
      attachments.addAll((draft['attachments'] as List? ?? []).map(object));
    }
    prompt.addListener(saveDraft);
    widget.store.refreshRepositories(widget.instanceId).catchError((Object e) {
      if (mounted) setState(() => error = e.toString());
      return <RepositoryReference>[];
    });
    read();
  }

  @override
  void dispose() {
    widget.store.removeListener(changed);
    saveDraft();
    prompt.removeListener(saveDraft);
    prompt.dispose();
    transcriptScroll.dispose();
    super.dispose();
  }

  void changed() {
    final connection = widget.store.connection;
    final reconnected = connection == 'Live' && previousConnection != 'Live';
    previousConnection = connection;
    if (mounted) setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && autoFollow && transcriptScroll.hasClients) {
        transcriptScroll.jumpTo(transcriptScroll.position.maxScrollExtent);
      }
    });
    if (reconnected && !busy) {
      scheduleMicrotask(() {
        if (mounted && !busy) read();
      });
    }
  }

  bool get owned => widget.store.canWrite(widget.instanceId);
  Future<void> run(Future<void> Function() work) async {
    if (busy) return;
    final generation = ++operation;
    setState(() {
      busy = true;
      error = null;
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

  void stopWaiting() {
    operation++;
    widget.store.stopWaiting(widget.instanceId);
    widget.store.abandonControl(widget.instanceId);
    setState(() {
      busy = false;
      error =
          'Stopped waiting. Your draft is kept. Query the original command before another write; viewing and navigation are available.';
    });
  }

  Future<void> repositories() async {
    final result = await Navigator.push<List<String>>(
      context,
      MaterialPageRoute(
        builder: (_) => RepositoriesPage(
          store: widget.store,
          instanceId: widget.instanceId,
          initialIds: referenceIds,
          pickForMessage: true,
        ),
      ),
    );
    if (result != null && mounted) {
      setState(() {
        referenceIds
          ..clear()
          ..addAll(result);
      });
      saveDraft();
    }
  }

  Future<void> control() async {
    final instance = widget.store.instance(widget.instanceId);
    if (instance == null) return;
    if (owned) {
      await run(() => widget.store.release(widget.instanceId));
      return;
    }
    final takeover =
        instance.lease != null &&
        !instance.lease!.expired &&
        instance.lease!.controllerId != widget.store.controllerId;
    if (takeover &&
        !await confirmDialog(
          context,
          'Take over this instance?',
          'The current writer loses control. A running operation may continue.',
          'Take over',
        )) {
      return;
    }
    await run(
      () => widget.store.acquire(widget.instanceId, takeover: takeover),
    );
  }

  Future<Object?> command(String action, JsonMap args) => widget.store.command(
    widget.instanceId,
    action,
    {'sessionId': widget.sessionId, ...args},
  );
  Future<void> read() => run(() async {
    final value = object(await command('session.read', {}));
    final cursor = (value['cursor'] as num?)?.toInt() ?? -1;
    final page = object(
      await widget.store.command(widget.instanceId, 'session.page', {
        'address': {'kind': 'session', 'sessionId': widget.sessionId},
        'throughSeq': cursor,
        'maxMessages': const int.fromEnvironment(
          'HISTORY_PAGE_SIZE',
          defaultValue: 25,
        ),
      }),
    );
    final records = (page['records'] as List? ?? []).map(
      (record) => object(object(record)['event']),
    );
    if (mounted) {
      setState(() {
        snapshot = value;
        historyCursor = cursor;
        history = mergeHistory([...history, ...records]);
        hasMoreHistory =
            page['hasMore'] == true &&
            (history.isEmpty || history.first['seq'] != 0);
      });
    }
    final projection = await command('session.projections', {});
    if (mounted) setState(() => projections = projection);
  });
  Future<void> older() => run(() async {
    if (history.isEmpty || !hasMoreHistory) return;
    autoFollow = false;
    final page = object(
      await widget.store.command(widget.instanceId, 'session.page', {
        'address': {'kind': 'session', 'sessionId': widget.sessionId},
        'throughSeq': historyCursor,
        'beforeSeq': history.first['seq'],
        'maxMessages': 25,
      }),
    );
    if (mounted) {
      setState(() {
        history = mergeHistory([
          ...history,
          ...(page['records'] as List? ?? []).map(
            (entry) => object(object(entry)['event']),
          ),
        ]);
        hasMoreHistory = page['hasMore'] == true;
      });
    }
  });
  Future<void> loadQueue() => run(() async {
    final value = await command('session.projections', {});
    if (mounted) setState(() => projections = value);
  });
  Future<void> changeQueue(JsonMap item, String kind) async {
    String? edited;
    if (kind == 'edit') {
      edited = await inputDialog(
        context,
        title: 'Edit queued message',
        label: 'Message text',
        hint: 'Editing replaces this queued message’s content with text.',
        initialValue: contentText(item['content']),
        multiline: true,
      );
      if (edited == null || !mounted) return;
    }
    if (kind == 'remove' &&
        !await confirmDialog(
          context,
          'Remove queued message?',
          contentText(item['content']),
          'Remove message',
        )) {
      return;
    }
    await run(() async {
      await command('session.queue.update', {
        'itemId': item['id'],
        'action': kind == 'edit'
            ? {
                'kind': kind,
                'content': [
                  {'type': 'text', 'text': edited},
                ],
              }
            : {'kind': kind},
      });
      final value = await command('session.projections', {});
      if (mounted) setState(() => projections = value);
    });
  }

  Future<void> send() async {
    final text = prompt.text.trim();
    if (text.isEmpty || !owned || busy) return;
    await run(() async {
      if (referenceIds.isNotEmpty) {
        await widget.store.refreshRepositories(widget.instanceId);
        final invalid = repositorySelectionError(references, widget.instanceId);
        if (invalid != null) throw StateError(invalid);
      }
      try {
        await widget.store.command(widget.instanceId, 'session.prompt', {
          'sessionId': widget.sessionId,
          'requestId': newId(),
          'mode': promptMode,
          'content': [
            {'type': 'text', 'text': text},
            for (final attachment in attachments)
              {'type': 'file', 'receiptId': attachment['receiptId']},
          ],
        }, repositoryIds: List<String>.of(referenceIds));
      } finally {
        if (referenceIds.isNotEmpty && widget.store.signedIn) {
          await widget.store.refreshRepositories(widget.instanceId);
        }
      }
      if (mounted) {
        prompt.clear();
        setState(() => attachments.clear());
        saveDraft();
      }
    });
  }

  Future<void> attach() async {
    await run(() async {
      final epoch = operation;
      final file = await openFile();
      if (file == null || !mounted || epoch != operation) return;
      if (await file.length() > 4 * 1024 * 1024) {
        throw StateError('Choose a file smaller than 4 MiB.');
      }
      final bytes = await file.readAsBytes();
      if (!mounted || epoch != operation) return;
      final result = await command('attachment.upload', {
        'name': file.name,
        'data': base64Encode(bytes),
      });
      if (mounted && epoch == operation) {
        setState(() => attachments.add(object(result)));
        saveDraft();
      }
    });
  }

  Future<void> model() async {
    final provider = await inputDialog(
      context,
      title: 'Choose provider',
      label: 'Provider identifier',
      hint: 'Use Settings to inspect the available model catalog',
    );
    if (provider == null || !mounted) return;
    final value = await inputDialog(
      context,
      title: 'Choose model',
      label: 'Model identifier',
      hint: 'This also updates the local DSH default model',
    );
    if (value != null && mounted) {
      await run(() async {
        await command('model.select', {'provider': provider, 'model': value});
      });
    }
  }

  Future<void> settings() async {
    await run(() async {
      final result = object(await command('settings.describe', {}));
      if (!mounted) return;
      final selection = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Session settings'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: SelectableText(
                pretty(result),
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
            if (owned)
              TextButton(
                onPressed: () => Navigator.pop(context, 'permissionPreset'),
                child: const Text('Permission preset'),
              ),
            if (owned)
              TextButton(
                onPressed: () => Navigator.pop(context, 'agentPreset'),
                child: const Text('Agent preset'),
              ),
          ],
        ),
      );
      if (selection == null || !mounted) return;
      final allowed =
          result[selection == 'permissionPreset'
              ? 'allowedPermissionPresets'
              : 'allowedAgentPresets'];
      final choices = allowed is List
          ? allowed.map((v) => v.toString()).toList()
          : <String>[];
      if (choices.isEmpty) {
        throw StateError(
          'No remotely selectable presets are configured on this connector.',
        );
      }
      final selected = await showDialog<String>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Choose an allowed preset'),
          children: [
            for (final value in choices)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(context, value),
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text(value),
                ),
              ),
          ],
        ),
      );
      if (selected == null || !mounted) return;
      if (!await confirmDialog(
        context,
        'Apply $selected?',
        'Update this session’s ${selection == 'permissionPreset' ? 'permission' : 'agent'} preset. Agent presets can only be changed before the first turn.',
        'Apply preset',
      )) {
        return;
      }
      await command('settings.update', {
        selection: selected,
        'expectedRevision': object(result['projections'])['asOfSeq'],
      });
    });
  }

  JsonMap review(JsonMap request) => approvalPresentation(
    request: request,
    snapshot: {...object(snapshot), 'events': mergedHistory},
    events: widget.store.events,
    instanceId: widget.instanceId,
    sessionId: widget.sessionId,
  );

  Future<void> respond(JsonMap request, bool allow) async {
    if (allow && review(request)['toolArgumentsAvailable'] != true) {
      setState(
        () => error =
            'Refresh the session to load the exact tool arguments before allowing this request.',
      );
      return;
    }
    if (!await confirmDialog(
      context,
      allow ? 'Allow this request once?' : 'Reject this request?',
      pretty(review(request)),
      allow ? 'Allow once' : 'Reject',
    )) {
      return;
    }
    await run(() async {
      await command('approval.respond', {
        'approvalId': request['approvalId'],
        'bootId': request['bootId'],
        'presentationHash': request['presentationHash'],
        'outcome': allow ? 'allowed-once' : 'rejected',
      });
    });
  }

  List<JsonMap> get mergedHistory => mergeHistory([
    ...history,
    for (final event in widget.store.events)
      if (event.instanceId == widget.instanceId &&
          event.kind == 'session.event' &&
          object(event.payload)['sessionId'] == widget.sessionId)
        object(object(event.payload)['data']),
  ]);
  Widget conversationView() {
    final events = mergedHistory;
    final stream =
        widget.store.streams['${widget.instanceId}:${widget.sessionId}'];
    return NotificationListener<UserScrollNotification>(
      onNotification: (notice) {
        autoFollow = notice.metrics.extentAfter < 100;
        return false;
      },
      child: ListView(
        controller: transcriptScroll,
        padding: const EdgeInsets.all(16),
        children: [
          if (hasMoreHistory)
            OutlinedButton.icon(
              onPressed: busy ? null : older,
              icon: const Icon(Icons.history),
              label: const Text('Load older history'),
            ),
          if (events.isEmpty && !busy)
            const EmptyState(
              icon: Icons.chat_bubble_outline,
              title: 'Start a conversation',
              detail: 'Send a prompt when you have control.',
            ),
          for (final event in events.where(
            (event) => {
              'user/message',
              'assistant/message',
              'tool/call',
              'tool/result',
            }.contains(event['type']),
          ))
            eventCard(event),
          if (stream != null && stream.text.isNotEmpty)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      stream.incomplete
                          ? 'DSH · live, partial stream'
                          : 'DSH · live',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                    const SizedBox(height: 8),
                    SelectableText(stream.text),
                  ],
                ),
              ),
            ),
          ExpansionTile(
            title: Text('Complete event timeline (${events.length})'),
            children: [
              for (final event in events)
                ExpansionTile(
                  title: Text('${event['type']} · #${event['seq']}'),
                  children: [SelectableText(pretty(event))],
                ),
            ],
          ),
          ExpansionTile(
            title: const Text('Session metadata and raw snapshot'),
            children: [SelectableText(pretty(snapshot))],
          ),
        ],
      ),
    );
  }

  Widget eventCard(JsonMap event) {
    final data = object(event['data']);
    String? role;
    String text = '';
    switch (event['type']) {
      case 'user/message':
        role = 'You';
        text = contentText(data['content']);
      case 'assistant/message':
        role = 'DSH';
        text = contentText(object(data['message'])['content']);
      case 'tool/result':
        role = 'Tool result';
        text = contentText(data['content']);
      case 'tool/call':
        role = 'Tool · ${data['name']}';
        text = data['arguments']?.toString() ?? '';
    }
    if (role == null) {
      return ExpansionTile(
        dense: true,
        title: Text(
          '${event['type']} · #${event['seq']}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        children: [
          SelectableText(
            pretty(event),
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
          ),
        ],
      );
    }
    return Align(
      alignment: role == 'You' ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 20),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width > 850
              ? 780
              : MediaQuery.sizeOf(context).width * .94,
        ),
        decoration: BoxDecoration(
          color: role == 'You'
              ? Theme.of(context).colorScheme.surfaceContainerHighest
              : Colors.transparent,
          borderRadius: BorderRadius.circular(
            role.startsWith('Tool') ? 12 : 16,
          ),
          border: role.startsWith('Tool')
              ? Border.all(color: Theme.of(context).dividerColor, width: .5)
              : null,
        ),
        child: Material(
          color: Colors.transparent,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(role, style: Theme.of(context).textTheme.labelLarge),
                const SizedBox(height: 8),
                SelectableText(
                  text.isEmpty
                      ? '(Structured content)'
                      : role == 'You'
                      ? text
                            .split(
                              '[Selected repository metadata: untrusted data]',
                            )
                            .first
                            .trim()
                      : text,
                ),
                if (role == 'You' &&
                    text.contains(
                      '[Selected repository metadata: untrusted data]',
                    ))
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text(
                      'Repository metadata included · inspect Details',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ExpansionTile(
                  dense: true,
                  title: Text('Details · #${event['seq']}'),
                  children: [
                    SelectableText(
                      pretty(event),
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget queueView() {
    final inbox = object(object(projections)['values'])['inbox'];
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        OutlinedButton.icon(
          onPressed: busy ? null : loadQueue,
          icon: const Icon(Icons.refresh),
          label: const Text('Refresh queue'),
        ),
        for (final lane in ['next-step', 'next-turn']) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text(
              lane == 'next-step' ? 'Next step · priority' : 'Next turn',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          for (final raw in (object(inbox)[lane] as List? ?? []))
            queueCard(object(raw), lane),
        ],
        const Text(
          'Prioritize moves a pending message to the next step boundary. Running operations continue until cancelled.',
        ),
      ],
    );
  }

  Widget queueCard(JsonMap item, String lane) => Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            contentText(item['content'])
                .split('[Selected repository metadata: untrusted data]')
                .first
                .trim(),
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
          ),
          if (contentText(
            item['content'],
          ).contains('[Selected repository metadata: untrusted data]'))
            const Text(
              'Repository metadata included',
              style: TextStyle(fontSize: 12),
            ),
          if (owned)
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: busy ? null : () => changeQueue(item, 'edit'),
                  child: const Text('Edit message'),
                ),
                if (lane == 'next-turn')
                  TextButton(
                    onPressed: busy ? null : () => changeQueue(item, 'steer'),
                    child: const Text('Prioritize next step'),
                  ),
                TextButton(
                  onPressed: busy ? null : () => changeQueue(item, 'remove'),
                  child: const Text('Remove'),
                ),
              ],
            ),
          ExpansionTile(
            title: const Text('Queue item details'),
            children: [SelectableText(pretty(item))],
          ),
        ],
      ),
    ),
  );

  Widget approvalPanel() {
    final requests = widget.store.pendingApprovals.values
        .where(
          (request) =>
              request['sessionId'] == widget.sessionId &&
              request['instanceId'] == widget.instanceId,
        )
        .toList();
    if (requests.isEmpty) return const SizedBox.shrink();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 170),
      child: ListView(
        shrinkWrap: true,
        children: [
          for (final request in requests)
            Card(
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(20),
                side: const BorderSide(color: Color(0xfff7ad31)),
              ),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Approval needed: ${request['toolName']}',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      request['reason']?.toString() ??
                          'Review the complete request before responding.',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (review(request)['toolArgumentsAvailable'] != true)
                      const Text(
                        'Refresh history to load matching tool arguments before allowing.',
                      ),
                    if (owned)
                      Row(
                        children: [
                          TextButton(
                            onPressed: busy
                                ? null
                                : () => respond(request, false),
                            child: const Text('Reject'),
                          ),
                          FilledButton.tonal(
                            onPressed:
                                busy ||
                                    review(request)['toolArgumentsAvailable'] !=
                                        true
                                ? null
                                : () => respond(request, true),
                            child: const Text('Review and allow'),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final events = widget.store.events
        .where(
          (e) =>
              e.instanceId == widget.instanceId &&
              (object(e.payload)['sessionId'] == null ||
                  object(e.payload)['sessionId'] == widget.sessionId),
        )
        .toList();
    return Scaffold(
      appBar: AppBar(
        leading: const BackButton(),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.store.instance(widget.instanceId)?.name ?? 'Harness',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            Text(
              object(snapshot)['title']?.toString() ?? widget.sessionId,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
        actions: [
          Builder(
            builder: (context) => IconButton(
              tooltip: 'Open navigation',
              onPressed: () => Scaffold.of(context).openDrawer(),
              icon: const Icon(Icons.menu),
            ),
          ),
          IconButton(
            tooltip: 'Load older history',
            onPressed: hasMoreHistory && !busy ? older : null,
            icon: const Icon(Icons.history),
          ),
          IconButton(
            tooltip: 'Refresh session',
            onPressed: busy ? null : read,
            icon: const Icon(Icons.refresh),
          ),
          PopupMenuButton<String>(
            enabled: true,
            onSelected: (value) async {
              if (value == 'repositories') await repositories();
              if (value == 'commands' && context.mounted) {
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => CommandHistoryPage(store: widget.store),
                  ),
                );
              }
              if (value == 'model') await model();
              if (value == 'settings') await settings();
              if (value == 'resume') {
                await run(() async {
                  await command('session.resume', {});
                });
              }
              if (value == 'cancel' &&
                  context.mounted &&
                  await confirmDialog(
                    context,
                    'Cancel this operation?',
                    'Send a cancellation to the currently running session operation.',
                    'Cancel operation',
                  )) {
                await run(() async {
                  await command('session.cancel', {});
                });
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(
                value: 'repositories',
                child: Text('Repository references'),
              ),
              const PopupMenuItem(
                value: 'commands',
                child: Text('Command history'),
              ),
              const PopupMenuItem(
                value: 'settings',
                child: Text('Settings and catalogs'),
              ),
              if (owned && !busy)
                const PopupMenuItem(
                  value: 'resume',
                  child: Text('Resume saved session'),
                ),
              if (owned && !busy)
                const PopupMenuItem(
                  value: 'model',
                  child: Text('Select model'),
                ),
              if (owned && !busy)
                const PopupMenuItem(
                  value: 'cancel',
                  child: Text('Cancel operation'),
                ),
            ],
          ),
        ],
      ),
      drawer: Drawer(
        child: SafeArea(
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.all(20),
                child: Text('deepseek harness', style: TextStyle(fontSize: 20)),
              ),
              ListTile(
                leading: const Icon(Icons.chat_bubble_outline),
                title: const Text('Sessions'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.pop(context);
                },
              ),
              ListTile(
                leading: const Icon(Icons.dns_outlined),
                title: const Text('Instances'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.popUntil(context, (route) => route.isFirst);
                },
              ),
              ListTile(
                leading: const Icon(Icons.account_tree_outlined),
                title: const Text('Repositories'),
                onTap: () {
                  Navigator.pop(context);
                  repositories();
                },
              ),
              ListTile(
                leading: const Icon(Icons.receipt_long_outlined),
                title: const Text('Command history'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => CommandHistoryPage(store: widget.store),
                    ),
                  );
                },
              ),
              const Spacer(),
              ListTile(
                leading: const Icon(Icons.close),
                title: const Text('Close navigation'),
                onTap: () => Navigator.pop(context),
              ),
            ],
          ),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (busy)
              Row(
                children: [
                  const Expanded(child: LinearProgressIndicator()),
                  TextButton(
                    onPressed: stopWaiting,
                    child: const Text('Stop waiting'),
                  ),
                ],
              ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.all(12),
                child: ErrorNotice(
                  error!,
                  onDismiss: () => setState(() => error = null),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: SegmentedButton<int>(
                segments: const [
                  ButtonSegment(value: 0, label: Text('Chat')),
                  ButtonSegment(value: 1, label: Text('Live')),
                  ButtonSegment(value: 2, label: Text('State')),
                  ButtonSegment(value: 3, label: Text('Queue')),
                ],
                selected: {tab},
                onSelectionChanged: (v) {
                  setState(() => tab = v.first);
                  if (tab == 3 && !busy) loadQueue();
                },
              ),
            ),
            Expanded(
              child: tab == 0
                  ? conversationView()
                  : tab == 3
                  ? queueView()
                  : tab == 1
                  ? ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: events.length,
                      itemBuilder: (context, index) {
                        final event = events[index];
                        return Card(
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${event.kind} · ${event.createdAt.toLocal().toString().substring(11, 19)}',
                                  style: Theme.of(context).textTheme.labelLarge,
                                ),
                                const SizedBox(height: 8),
                                SelectableText(
                                  pretty(event.payload),
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    )
                  : SingleChildScrollView(
                      padding: const EdgeInsets.all(16),
                      child: Align(
                        alignment: Alignment.topLeft,
                        child: SelectableText(
                          (tab == 0 ? snapshot : projections) == null
                              ? 'No snapshot loaded yet.'
                              : pretty(tab == 0 ? snapshot : projections),
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ),
            ),
            if (widget.store.journalError != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: ErrorNotice(widget.store.journalError!),
              ),
            approvalPanel(),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 812),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              '${widget.store.instance(widget.instanceId)?.statusLabel ?? 'Offline'} · ${widget.store.connection == 'Live' ? '' : '${widget.store.connection} · '}${owned ? 'Writer' : 'Observer'}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                          TextButton(
                            onPressed:
                                busy ||
                                    widget.store
                                            .instance(widget.instanceId)
                                            ?.online !=
                                        true ||
                                    widget.store.connection != 'Live'
                                ? null
                                : control,
                            child: Text(
                              owned ? 'Release control' : 'Take control',
                            ),
                          ),
                        ],
                      ),
                      if (widget.store.hasUnresolvedWrite(widget.instanceId))
                        Row(
                          children: [
                            const Expanded(
                              child: Text(
                                'A write is unresolved. Query its original result.',
                                style: TextStyle(fontSize: 12),
                              ),
                            ),
                            TextButton(
                              onPressed: () => Navigator.push(
                                context,
                                MaterialPageRoute<void>(
                                  builder: (_) =>
                                      CommandHistoryPage(store: widget.store),
                                ),
                              ),
                              child: const Text('Query result'),
                            ),
                          ],
                        ),
                      Container(
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.surface,
                          borderRadius: BorderRadius.circular(28),
                          border: Border.all(
                            color: Theme.of(context).dividerColor,
                            width: .5,
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: .04),
                              blurRadius: 16,
                              offset: const Offset(0, 3),
                            ),
                          ],
                        ),
                        padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (referenceIds.isNotEmpty)
                              SizedBox(
                                height: 44,
                                child: ListView(
                                  scrollDirection: Axis.horizontal,
                                  children: [
                                    for (final reference in references)
                                      Padding(
                                        padding: const EdgeInsets.only(
                                          right: 6,
                                        ),
                                        child: InputChip(
                                          label: Text(
                                            '${reference.fullName}${reference.verified ? '' : ' · ${reference.localState}'}',
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          onPressed: () =>
                                              showRepositoryPreview(context, [
                                                reference,
                                              ]),
                                          onDeleted: () {
                                            setState(
                                              () => referenceIds.remove(
                                                reference.id,
                                              ),
                                            );
                                            saveDraft();
                                          },
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            if (attachments.isNotEmpty)
                              SizedBox(
                                height: 42,
                                child: ListView(
                                  scrollDirection: Axis.horizontal,
                                  children: [
                                    for (final attachment in attachments)
                                      InputChip(
                                        label: Text(
                                          attachment['name']?.toString() ??
                                              'Attachment',
                                        ),
                                        onDeleted: busy
                                            ? null
                                            : () {
                                                setState(
                                                  () => attachments.remove(
                                                    attachment,
                                                  ),
                                                );
                                                saveDraft();
                                              },
                                      ),
                                  ],
                                ),
                              ),
                            TextField(
                              controller: prompt,
                              minLines: 1,
                              maxLines: 5,
                              enabled: !busy,
                              decoration: const InputDecoration(
                                hintText: 'Send a message to Harness…',
                                filled: false,
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                contentPadding: EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 12,
                                ),
                              ),
                              textInputAction: TextInputAction.newline,
                            ),
                            Row(
                              children: [
                                IconButton(
                                  tooltip: 'Upload attachment',
                                  onPressed:
                                      owned &&
                                          !busy &&
                                          !widget.store.hasUnresolvedWrite(
                                            widget.instanceId,
                                          )
                                      ? attach
                                      : null,
                                  icon: const Icon(Icons.add),
                                  iconSize: 22,
                                ),
                                IconButton(
                                  tooltip: 'Repository references',
                                  onPressed: repositories,
                                  icon: const Icon(Icons.account_tree_outlined),
                                  iconSize: 20,
                                ),
                                Expanded(
                                  child: DropdownButtonHideUnderline(
                                    child: DropdownButton<String>(
                                      isExpanded: true,
                                      value: promptMode,
                                      style: Theme.of(
                                        context,
                                      ).textTheme.bodySmall,
                                      items: const [
                                        DropdownMenuItem(
                                          value: 'queue',
                                          child: Text('Queue'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'steer',
                                          child: Text('Steer next step'),
                                        ),
                                      ],
                                      onChanged: busy
                                          ? null
                                          : (value) {
                                              setState(
                                                () => promptMode = value!,
                                              );
                                              saveDraft();
                                            },
                                    ),
                                  ),
                                ),
                                IconButton.filled(
                                  tooltip: 'Send prompt',
                                  style: IconButton.styleFrom(
                                    backgroundColor: Theme.of(
                                      context,
                                    ).colorScheme.primary,
                                    foregroundColor: Colors.white,
                                    disabledBackgroundColor: Theme.of(
                                      context,
                                    ).colorScheme.surfaceContainerHighest,
                                    disabledForegroundColor: Theme.of(
                                      context,
                                    ).colorScheme.onSurfaceVariant,
                                  ),
                                  onPressed:
                                      owned &&
                                          !busy &&
                                          !widget.store.hasUnresolvedWrite(
                                            widget.instanceId,
                                          ) &&
                                          repositorySelectionError(
                                                references,
                                                widget.instanceId,
                                              ) ==
                                              null
                                      ? send
                                      : null,
                                  icon: const Icon(Icons.arrow_upward),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Model and tools run on your DSH host',
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(fontSize: 11),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ErrorNotice extends StatelessWidget {
  const ErrorNotice(this.text, {this.onDismiss, super.key});
  final String text;
  final VoidCallback? onDismiss;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(8),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 86),
            child: SingleChildScrollView(
              child: Text(
                text,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onErrorContainer,
                ),
              ),
            ),
          ),
        ),
        if (onDismiss != null)
          IconButton(
            tooltip: 'Dismiss error',
            onPressed: onDismiss,
            icon: const Icon(Icons.close),
          ),
      ],
    ),
  );
}

class StatusPill extends StatelessWidget {
  const StatusPill(this.text, {this.good = false, super.key});
  final String text;
  final bool good;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(30),
    ),
    child: Text(
      text,
      style: TextStyle(
        color: good
            ? Theme.of(context).colorScheme.primary
            : Theme.of(context).colorScheme.onSurfaceVariant,
        fontSize: 12,
      ),
    ),
  );
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    required this.icon,
    required this.title,
    required this.detail,
    super.key,
  });
  final IconData icon;
  final String title;
  final String detail;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
    child: Column(
      children: [
        Icon(
          icon,
          size: 40,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        const SizedBox(height: 16),
        Text(title, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(
          detail,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    ),
  );
}

void message(BuildContext context, String text) =>
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
Future<bool> confirmDialog(
  BuildContext context,
  String title,
  String detail,
  String action,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(child: Text(detail)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Back'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;
Future<String?> inputDialog(
  BuildContext context, {
  required String title,
  required String label,
  String? hint,
  String initialValue = '',
  bool multiline = false,
}) async {
  final controller = TextEditingController(text: initialValue);
  final result = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        minLines: 1,
        maxLines: multiline ? 6 : 1,
        decoration: InputDecoration(labelText: label, helperText: hint),
        onSubmitted: (value) {
          if (value.trim().isNotEmpty) Navigator.pop(context, value.trim());
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (controller.text.trim().isNotEmpty) {
              Navigator.pop(context, controller.text.trim());
            }
          },
          child: const Text('Continue'),
        ),
      ],
    ),
  );
  // The closing route may still use the text controller during its reverse transition.
  Future<void>.delayed(const Duration(seconds: 1), controller.dispose);
  return result;
}

class CommandHistoryPage extends StatelessWidget {
  const CommandHistoryPage({required this.store, super.key});
  final RemoteStore store;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Command history')),
    body: ListenableBuilder(
      listenable: store,
      builder: (context, _) => ListView(
        padding: const EdgeInsets.all(18),
        children: [
          if (store.journalError != null) ErrorNotice(store.journalError!),
          TextButton.icon(
            onPressed: store.restoreCommandJournal,
            icon: const Icon(Icons.lock_reset),
            label: const Text('Reload saved command journal'),
          ),
          const Text(
            'Query the original operation ID. An unknown result is never automatically resubmitted. A missing result can race an in-flight request; refresh again without creating another command.',
          ),
          if (store.commands.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No commands in this login session.'),
            ),
          for (final command in store.commands.values.toList().reversed)
            Card(
              child: ExpansionTile(
                title: Text(command.json['action']?.toString() ?? command.id),
                subtitle: Text(command.status),
                childrenPadding: const EdgeInsets.all(14),
                children: [
                  SelectableText(pretty(command.json)),
                  TextButton.icon(
                    onPressed: () async {
                      try {
                        await store.checkCommand(command.id);
                      } catch (e) {
                        if (context.mounted) {
                          await showDialog<void>(
                            context: context,
                            builder: (c) => AlertDialog(
                              title: const Text('Result not confirmed'),
                              content: Text(e.toString()),
                              actions: [
                                TextButton(
                                  onPressed: () => Navigator.pop(c),
                                  child: const Text('Close'),
                                ),
                              ],
                            ),
                          );
                        }
                      }
                    },
                    icon: const Icon(Icons.refresh),
                    label: const Text('Query original result'),
                  ),
                ],
              ),
            ),
        ],
      ),
    ),
  );
}
