import 'dart:async';
import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import 'src/api.dart';
import 'src/models.dart';
import 'src/credentials.dart';
import 'src/store.dart';
import 'src/theme.dart';
import 'src/ui.dart';
import 'src/repositories_page.dart';
import 'src/workspace_picker.dart';

export 'src/ui.dart' show ErrorNotice;

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

/// Sign in and create account are one form: the title, the primary button
/// and the mode switch change in place.
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
  Widget build(BuildContext context) {
    final store = widget.store;
    final text = Theme.of(context).textTheme;
    const gap = SizedBox(height: Space.m);
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(
            Space.xl,
            Space.xxxl,
            Space.xl,
            Space.xl,
          ),
          child: Align(
            alignment: Alignment.topLeft,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Form(
                key: form,
                child: AutofillGroup(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Swap(
                        child: Text(
                          register
                              ? 'Create a relay account'
                              : 'Sign in to your relay',
                          key: ValueKey(register),
                          style: text.headlineMedium,
                        ),
                      ),
                      const SizedBox(height: Space.xxl),
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
                      gap,
                      TextFormField(
                        controller: email,
                        decoration: const InputDecoration(labelText: 'Email'),
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.username],
                        autocorrect: false,
                        validator: requiredValue,
                      ),
                      gap,
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
                            tooltip: obscure
                                ? 'Show password'
                                : 'Hide password',
                            onPressed: () => setState(() => obscure = !obscure),
                            icon: AnimatedSwitcher(
                              duration: motion(context),
                              child: Icon(
                                obscure
                                    ? Icons.visibility_outlined
                                    : Icons.visibility_off_outlined,
                                key: ValueKey(obscure),
                                size: 20,
                              ),
                            ),
                          ),
                        ),
                        validator: (v) => (v?.length ?? 0) < 8 && register
                            ? 'Use at least 8 characters'
                            : requiredValue(v),
                        onFieldSubmitted: (_) => submit(),
                      ),
                      gap,
                      TextFormField(
                        controller: name,
                        decoration: const InputDecoration(
                          labelText: 'Controller name',
                        ),
                        validator: requiredValue,
                      ),
                      Reveal(
                        padding: const EdgeInsets.only(top: Space.l),
                        child: store.error == null
                            ? null
                            : ErrorNotice(store.error!),
                      ),
                      const SizedBox(height: Space.xl),
                      Wrap(
                        spacing: Space.l,
                        runSpacing: Space.s,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          FilledButton(
                            onPressed: store.busy ? null : submit,
                            child: Resize(
                              child: Swap(
                                child: store.busy
                                    ? SizedBox(
                                        key: const ValueKey('busy'),
                                        width: 18,
                                        height: 18,
                                        child: CircularProgressIndicator(
                                          color: HarnessColors.of(
                                            context,
                                          ).secondary,
                                        ),
                                      )
                                    : Text(
                                        register ? 'Create account' : 'Sign in',
                                        key: ValueKey(register),
                                      ),
                              ),
                            ),
                          ),
                          Swap(
                            child: store.busy
                                ? TextButton(
                                    key: const ValueKey('cancel'),
                                    style: edgeAction,
                                    onPressed: store.cancelAuthentication,
                                    child: const Text('Cancel sign-in'),
                                  )
                                : TextButton(
                                    key: ValueKey('mode-$register'),
                                    style: edgeAction,
                                    onPressed: () =>
                                        setState(() => register = !register),
                                    child: Text(
                                      register
                                          ? 'Already have an account? Sign in'
                                          : 'Create an account',
                                    ),
                                  ),
                          ),
                        ],
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          style: edgeAction,
                          onPressed: store.busy ? null : store.restore,
                          child: const Text('Restore saved session'),
                        ),
                      ),
                      const SizedBox(height: Space.xl),
                      Text(
                        'The session is kept in device secure storage and your password is never saved. Use HTTPS for remote servers.',
                        style: text.bodySmall,
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
  static const sections = ['Instances', 'Command history', 'Account & devices'];
  int tab = 0;
  bool creating = false;
  Future<void> createInstance() async {
    final value = await inputDialog(
      context,
      title: 'Add instance',
      label: 'Instance name',
    );
    if (value == null || !mounted) return;
    setState(() => creating = true);
    try {
      final result = await widget.store.createInstance(value);
      if (!mounted) return;
      final token = result['connectorToken'].toString();
      final id = object(result['instance'])['id'].toString();
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => plainDialog(
          title: const Text('Connect your local DSH'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'This token is shown once. Save it in an owner-only file (0600) inside a private directory (0700) on the DSH machine, set connectorTokenFile to that absolute path with the relay URL, then clear your clipboard.',
                ),
                const SizedBox(height: Space.l),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: CodeBlock(token)),
                    const SizedBox(width: Space.xs),
                    CopyIconButton(text: token, tooltip: 'Copy token'),
                  ],
                ),
                const SizedBox(height: Space.m),
                SelectableText(
                  'Relay: ${widget.store.server}\nInstance: $id',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: Space.m),
                ListenableBuilder(
                  listenable: widget.store,
                  builder: (context, _) =>
                      StatusDot.forInstance(widget.store.instance(id)),
                ),
              ],
            ),
          ),
          actions: [
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
  Widget build(BuildContext context) {
    final store = widget.store;
    final notice = store.error ?? store.journalError;
    return Scaffold(
      appBar: AppBar(
        actions: [
          Center(child: StatusDot.relay(store.connection)),
          const SizedBox(width: Space.xs),
          IconButton(
            tooltip: 'Refresh',
            onPressed: () {
              store.retryNow();
              store.refresh();
            },
            icon: const Icon(Icons.refresh),
          ),
          const SizedBox(width: Space.xs),
        ],
      ),
      drawer: Drawer(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.symmetric(
              horizontal: Space.m,
              vertical: Space.l,
            ),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Space.l,
                  Space.s,
                  Space.l,
                  Space.xl,
                ),
                child: Text(
                  'DSH Remote',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              for (var i = 0; i < sections.length; i++)
                ListTile(
                  selected: tab == i,
                  title: Text(sections[i]),
                  onTap: () {
                    Navigator.pop(context);
                    setState(() => tab = i);
                  },
                ),
            ],
          ),
        ),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Reveal(
            padding: const EdgeInsets.fromLTRB(Space.l, 0, Space.l, Space.m),
            child: notice == null ? null : ErrorNotice(notice),
          ),
          Expanded(
            child: AnimatedSwitcher(
              duration: motion(context),
              switchInCurve: motionCurve,
              switchOutCurve: motionCurve,
              transitionBuilder: fadeSlide,
              child: KeyedSubtree(
                key: ValueKey(tab),
                child: switch (tab) {
                  0 => instancesView(),
                  1 => CommandHistoryView(
                    store: store,
                    showJournalError: false,
                  ),
                  _ => controllersView(),
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget instancesView() {
    final store = widget.store;
    final text = Theme.of(context).textTheme;
    return RefreshIndicator(
      onRefresh: () {
        store.retryNow();
        return store.refresh();
      },
      child: ListView(
        padding: const EdgeInsets.only(top: Space.s, bottom: Space.xxxl),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: pageInset,
            child: Text('Instances', style: text.headlineMedium),
          ),
          const SizedBox(height: Space.l),
          if (store.instances.isEmpty)
            Padding(
              padding: pageInset,
              child: Text(
                'No instances yet',
                style: text.bodyMedium?.copyWith(
                  color: HarnessColors.of(context).secondary,
                ),
              ),
            ),
          for (final instance in store.instances) instanceRow(instance),
          const SizedBox(height: Space.l),
          Padding(
            padding: pageInset,
            child: Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: creating ? null : createInstance,
                icon: Swap(
                  child: creating
                      ? const SizedBox(
                          key: ValueKey('creating'),
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(),
                        )
                      : const Icon(Icons.add, size: 20),
                ),
                label: const Text('Add instance'),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget instanceRow(Instance instance) {
    final text = Theme.of(context).textTheme;
    final store = widget.store;
    return InkWell(
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) => InstancePage(store: store, id: instance.id),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: Space.l,
          vertical: Space.m,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(
                    instance.name,
                    style: text.titleMedium,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: Space.m),
                StatusDot.forInstance(instance),
              ],
            ),
            const SizedBox(height: Space.xs),
            Text(
              store.canWrite(instance.id)
                  ? 'In control'
                  : instance.lease != null && !instance.lease!.expired
                  ? 'In use'
                  : 'No active controller',
              style: text.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> revoke(JsonMap controller) async {
    final store = widget.store;
    final id = controller['id'].toString();
    final name = controller['name']?.toString() ?? 'Controller';
    if (!await confirmDialog(
      context,
      'Revoke $name?',
      'Its current login ($id) loses access and writer control.${id == store.controllerId ? ' This is this device, so you will be signed out.' : ''}',
      'Revoke device',
    )) {
      return;
    }
    try {
      await store.api!.request(
        'POST',
        'api/controllers/${Uri.encodeComponent(id)}/revoke',
        {'controllerId': store.controllerId},
      );
      if (id == store.controllerId) {
        await store.signOut(revoke: false);
      } else {
        await store.refresh();
      }
    } catch (e) {
      if (mounted) message(context, e.toString());
    }
  }

  Widget controllersView() {
    final store = widget.store;
    final text = Theme.of(context).textTheme;
    return ListView(
      padding: const EdgeInsets.only(top: Space.s, bottom: Space.xxxl),
      children: [
        Padding(
          padding: pageInset,
          child: Text('Account & devices', style: text.headlineMedium),
        ),
        const SizedBox(height: Space.l),
        Padding(
          padding: pageInset,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                store.user?['email']?.toString() ?? '',
                style: text.titleMedium,
              ),
              Text(store.server, style: text.bodySmall),
            ],
          ),
        ),
        const SizedBox(height: Space.xxl),
        Padding(
          padding: pageInset,
          child: Text('Devices', style: text.titleLarge),
        ),
        const SizedBox(height: Space.s),
        for (final controller in store.controllers)
          ListTile(
            title: Text(controller['name']?.toString() ?? 'Controller'),
            subtitle: Text(
              controller['id'] == store.controllerId
                  ? 'This device'
                  : controller['id'].toString(),
            ),
            trailing: controller['active'] == true
                ? IconButton(
                    tooltip: 'Revoke ${controller['name']}',
                    icon: const Icon(Icons.logout, size: 20),
                    onPressed: () => revoke(controller),
                  )
                : Text('Revoked', style: text.bodySmall),
          ),
        const SizedBox(height: Space.xxl),
        Padding(
          padding: pageInset,
          child: Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: () async {
                final confirm = await confirmDialog(
                  context,
                  'Sign out?',
                  'Your secure session will be removed and revoked. Any writer lease stops renewing and expires within 30 seconds.',
                  'Sign out',
                );
                if (confirm) await store.signOut();
              },
              child: const Text('Sign out'),
            ),
          ),
        ),
      ],
    );
  }
}

/// Control of the instance a page shows, shared by the instance and session
/// pages. Connecting takes control, as in remote-desktop clients: a free
/// instance is controlled at once, a lease this device still holds is resumed
/// after a reconnect, and another device's control is only taken after asking
/// (see [RemoteStore.autoControlStep]). Declining, releasing or being pushed
/// off leaves the instance watch-only until the person asks for control.
mixin InstanceControl<T extends StatefulWidget> on State<T> {
  RemoteStore get store;
  String get instanceId;
  bool get busy;

  /// True while the running operation is an acquire or release.
  bool get controlling;

  /// Runs a lease operation with the page's progress and error handling.
  Future<void> runControl(Future<void> Function() operation);

  bool _onTop = true;
  bool _choosing = false;
  bool _checkScheduled = false;

  Instance? get controlled => store.instance(instanceId);

  /// The other device holding [instance]'s lease, if any.
  String? otherHolder(Instance? instance) {
    final lease = instance?.lease;
    return lease != null &&
            !lease.expired &&
            lease.controllerId != store.controllerId
        ? lease.controllerId
        : null;
  }

  ControlState get controlState {
    final instance = controlled;
    final lease = instance?.lease;
    if (controlling ||
        (lease != null &&
            !lease.expired &&
            lease.pending &&
            lease.controllerId == store.controllerId)) {
      return ControlState.confirming;
    }
    if (store.canWrite(instanceId)) return ControlState.owned;
    if (otherHolder(instance) != null) return ControlState.takeover;
    return ControlState.available;
  }

  /// No control button for an offline instance.
  bool get showsControl => (controlled?.status ?? 'offline') != 'offline';

  /// Whether control can be asked for or released right now.
  bool get controlReady =>
      !busy && controlled?.online == true && store.connection == 'Live';

  /// Call from build: notes whether this page is on top, and checks for an
  /// automatic control step once the frame is done.
  void watchControl(BuildContext context) {
    _onTop = ModalRoute.isCurrentOf(context) ?? true;
    if (_checkScheduled) return;
    _checkScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkScheduled = false;
      if (mounted) unawaited(autoControl());
    });
  }

  Future<void> autoControl() async {
    // Only the page on top acts: never under a dialog, a pushed page or
    // while an operation runs.
    if (_choosing || busy || !_onTop) return;
    final step = store.autoControlStep(instanceId);
    if (step == null) return;
    _choosing = true;
    try {
      if (step == AutoControl.prompt) {
        await _confirmTakeover();
      } else {
        await runControl(() => store.acquire(instanceId));
      }
    } finally {
      _choosing = false;
    }
  }

  /// The control button: releases when in control, otherwise asks for it.
  Future<void> toggleControl() async {
    if (store.canWrite(instanceId)) {
      store.setWatchOnly(instanceId, true);
      await runControl(() => store.release(instanceId));
      return;
    }
    await takeControl();
  }

  /// Explicitly asks for control, confirming before pushing another device
  /// off. True once control is ours.
  Future<bool> takeControl() async {
    if (_choosing) return false;
    _choosing = true;
    try {
      store.setWatchOnly(instanceId, false);
      if (otherHolder(controlled) != null) return await _confirmTakeover();
      await runControl(() => store.acquire(instanceId));
      return store.canWrite(instanceId);
    } finally {
      _choosing = false;
    }
  }

  Future<bool> _confirmTakeover() async {
    final name = await store.controllerName(otherHolder(controlled));
    if (!mounted) return false;
    final confirmed = await takeoverDialog(context, name);
    if (!mounted) return false;
    if (!confirmed) {
      store.setWatchOnly(instanceId, true);
      return false;
    }
    await runControl(() => store.acquire(instanceId, takeover: true));
    return store.canWrite(instanceId);
  }

  /// Stops waiting for the running operation. Control is dropped until the
  /// person asks for it again.
  void abandonOperation() {
    store.stopWaiting(instanceId);
    store.abandonControl(instanceId);
    store.setWatchOnly(instanceId, true);
  }

  /// The "… took over control. Watching only." notice until dismissed.
  Widget controlNotice(EdgeInsetsGeometry padding) {
    final notice = store.controlNotices[instanceId];
    return Reveal(
      padding: padding,
      child: notice == null
          ? null
          : Notice(
              notice,
              onDismiss: () => store.dismissControlNotice(instanceId),
            ),
    );
  }
}

class InstancePage extends StatefulWidget {
  const InstancePage({required this.store, required this.id, super.key});
  final RemoteStore store;
  final String id;
  @override
  State<InstancePage> createState() => _InstancePageState();
}

class _InstancePageState extends State<InstancePage>
    with InstanceControl<InstancePage> {
  @override
  bool busy = false;
  int operationEpoch = 0;
  int controlEpoch = -1;
  String? error;
  List<JsonMap> sessions = [];
  @override
  RemoteStore get store => widget.store;
  @override
  String get instanceId => widget.id;
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

  @override
  bool get controlling => busy && controlEpoch == operationEpoch;

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

  @override
  Future<void> runControl(Future<void> Function() operation) {
    controlEpoch = operationEpoch + 1;
    return run(operation);
  }

  void stopWaiting() {
    operationEpoch++;
    abandonOperation();
    setState(() {
      busy = false;
      error =
          'Stopped waiting. Refresh status and query any submitted command before trying again.';
    });
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

  /// New session needs control: a free instance is acquired first, another
  /// device's control is taken over after asking, then the folder is chosen.
  Future<void> createSession() async {
    if (!store.canWrite(widget.id) && !await takeControl()) return;
    if (!mounted) return;
    // Plugins that predate the folder picker create in their default folder.
    final browsable =
        store.instance(widget.id)?.capabilities.contains('workspace.browse') ==
        true;
    String? cwd;
    if (browsable) {
      cwd = await showNewSessionDialog(
        context,
        store: store,
        instanceId: widget.id,
      );
      if (cwd == null) return;
    } else if (!await confirmDialog(
      context,
      'New session?',
      'Create a session in the connector’s configured default workspace.',
      'Create session',
    )) {
      return;
    }
    if (!mounted) return;
    await run(() async {
      try {
        await widget.store.command(widget.id, 'session.create', {
          'sessionId': newId(),
          'cwd': ?cwd,
        });
      } on ApiException catch (e) {
        throw ApiException(e.code, workspaceErrorText(e), e.statusCode);
      }
    });
    if (error == null) await load();
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    final text = Theme.of(context).textTheme;
    watchControl(context);
    final instance = store.instance(widget.id);
    if (instance == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Padding(
          padding: pageInset,
          child: Text('Instance no longer available.'),
        ),
      );
    }
    final state = controlState;
    final canStartSession = controlReady && state != ControlState.confirming;
    return Scaffold(
      appBar: AppBar(
        actions: [
          IconButton(
            tooltip: 'Repositories',
            icon: const Icon(Icons.account_tree_outlined),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) =>
                    RepositoriesPage(store: store, instanceId: widget.id),
              ),
            ),
          ),
          IconButton(
            tooltip: 'Refresh instance status',
            onPressed: busy ? null : load,
            icon: const Icon(Icons.refresh),
          ),
          const SizedBox(width: Space.xs),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          BusyBar(busy: busy, onStop: stopWaiting),
          Expanded(
            child: RefreshIndicator(
              onRefresh: load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.only(
                  top: Space.s,
                  bottom: Space.xxxl,
                ),
                children: [
                  Padding(
                    padding: pageInset,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: Space.m,
                          runSpacing: Space.xs,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(instance.name, style: text.headlineMedium),
                            StatusDot.instance(store, instance),
                          ],
                        ),
                        const SizedBox(height: Space.xs),
                        Text(
                          instance.lastSeenAt == null
                              ? 'No heartbeat observed yet'
                              : 'Last seen: ${shortTime(instance.lastSeenAt!)}',
                          style: text.bodySmall,
                        ),
                        Reveal(
                          padding: const EdgeInsets.only(top: Space.l),
                          child: showsControl
                              ? ControlButton(
                                  state: state,
                                  onPressed: controlReady
                                      ? toggleControl
                                      : null,
                                )
                              : null,
                        ),
                      ],
                    ),
                  ),
                  controlNotice(
                    const EdgeInsets.fromLTRB(Space.l, Space.l, Space.l, 0),
                  ),
                  Reveal(
                    padding: const EdgeInsets.fromLTRB(
                      Space.l,
                      Space.l,
                      Space.l,
                      0,
                    ),
                    child: error == null
                        ? null
                        : ErrorNotice(
                            error!,
                            onDismiss: () => setState(() => error = null),
                          ),
                  ),
                  const SizedBox(height: Space.xxl),
                  Padding(
                    padding: const EdgeInsets.only(
                      left: Space.l,
                      right: Space.xs,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text('Sessions', style: text.titleLarge),
                        ),
                        TextButton.icon(
                          onPressed: canStartSession ? createSession : null,
                          icon: const Icon(Icons.add, size: 20),
                          label: const Text('New session'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: Space.xs),
                  if (sessions.isEmpty && !busy)
                    Padding(
                      padding: pageInset,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'No sessions',
                            style: text.bodyMedium?.copyWith(
                              color: HarnessColors.of(context).secondary,
                            ),
                          ),
                          if (instance.online) ...[
                            const SizedBox(height: Space.l),
                            FilledButton.icon(
                              onPressed: canStartSession ? createSession : null,
                              icon: const Icon(Icons.add, size: 20),
                              label: const Text('New session'),
                            ),
                          ],
                        ],
                      ),
                    ),
                  for (final session in sessions) sessionRow(session),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget sessionRow(JsonMap session) {
    final id = sessionId(session);
    final title =
        session['title']?.toString() ?? session['cwd']?.toString() ?? id;
    return ListTile(
      title: Text(title),
      subtitle: title == id ? null : Text(id),
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) => SessionPage(
            store: widget.store,
            instanceId: widget.id,
            sessionId: id,
          ),
        ),
      ),
    );
  }
}

String sessionId(JsonMap session) =>
    (session['sessionId'] ?? session['id'] ?? session['sessionKey'] ?? '')
        .toString();

const repositoryMarker = '[Selected repository metadata: untrusted data]';

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

class _SessionPageState extends State<SessionPage>
    with InstanceControl<SessionPage> {
  final prompt = TextEditingController();
  final transcriptScroll = ScrollController();
  bool autoFollow = true;
  @override
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
  int controlOperation = -1;
  int statusSeqAtRead = -1;
  String get draftKey => '${widget.instanceId}:${widget.sessionId}';
  @override
  RemoteStore get store => widget.store;
  @override
  String get instanceId => widget.instanceId;
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

  @override
  bool get controlling => busy && controlOperation == operation;

  RelayEvent? get latestStatus {
    for (final event in widget.store.events.reversed) {
      if (event.instanceId == widget.instanceId &&
          event.kind == 'session.status' &&
          object(event.payload)['sessionId'] == widget.sessionId) {
        return event;
      }
    }
    return null;
  }

  /// Whether the session's agent is running, from the newest of the last
  /// read snapshot and live status events.
  bool get running {
    final status = latestStatus;
    if (status != null && status.seq > statusSeqAtRead) {
      return object(object(status.payload)['data'])['running'] == true;
    }
    return object(snapshot)['running'] == true;
  }

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

  @override
  Future<void> runControl(Future<void> Function() work) {
    controlOperation = operation + 1;
    return run(work);
  }

  void stopWaiting() {
    operation++;
    abandonOperation();
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

  void commandHistory() => Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => CommandHistoryPage(store: widget.store),
    ),
  );

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
        statusSeqAtRead = latestStatus?.seq ?? -1;
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

  Future<void> cancelOperation() async {
    if (!await confirmDialog(
      context,
      'Cancel this operation?',
      'Send a cancellation to the currently running session operation.',
      'Cancel operation',
    )) {
      return;
    }
    await run(() async {
      await command('session.cancel', {});
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
        builder: (context) => plainDialog(
          title: const Text('Session settings'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(child: CodeBlock(pretty(result))),
          ),
          actions: [
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
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
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
                padding: const EdgeInsets.symmetric(
                  horizontal: Space.xl,
                  vertical: Space.m,
                ),
                onPressed: () => Navigator.pop(context, value),
                child: Text(value),
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
      code: true,
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

  Text quiet(String value) => Text(
    value,
    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
      color: HarnessColors.of(context).secondary,
    ),
  );

  Widget conversationView() {
    final events = mergedHistory;
    final stream =
        widget.store.streams['${widget.instanceId}:${widget.sessionId}'];
    final text = Theme.of(context).textTheme;
    final secondary = HarnessColors.of(context).secondary;
    return NotificationListener<UserScrollNotification>(
      onNotification: (notice) {
        autoFollow = notice.metrics.extentAfter < 100;
        return false;
      },
      child: ListView(
        controller: transcriptScroll,
        padding: const EdgeInsets.all(Space.l),
        children: [
          if (events.isEmpty && !busy) quiet('No messages yet'),
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
            Padding(
              padding: const EdgeInsets.only(bottom: Space.xl),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    stream.incomplete
                        ? 'DSH · live, partial stream'
                        : 'DSH · live',
                    style: text.labelMedium?.copyWith(color: secondary),
                  ),
                  const SizedBox(height: Space.xs),
                  SelectableText(stream.text, style: text.bodyLarge),
                ],
              ),
            ),
          ExpansionTile(
            dense: true,
            title: Text(
              'Event timeline (${events.length})',
              style: text.bodySmall,
            ),
            children: [
              for (final event in events)
                ExpansionTile(
                  dense: true,
                  title: Text(
                    '${event['type']} · #${event['seq']}',
                    style: text.bodySmall,
                  ),
                  children: [CodeBlock(pretty(event))],
                ),
            ],
          ),
          ExpansionTile(
            dense: true,
            title: Text('Raw snapshot', style: text.bodySmall),
            children: [CodeBlock(pretty(snapshot))],
          ),
        ],
      ),
    );
  }

  Widget eventCard(JsonMap event) {
    final data = object(event['data']);
    final text = Theme.of(context).textTheme;
    final colors = HarnessColors.of(context);
    final String role;
    final String body;
    switch (event['type']) {
      case 'user/message':
        role = 'You';
        body = contentText(data['content']);
      case 'assistant/message':
        role = 'DSH';
        body = contentText(object(data['message'])['content']);
      case 'tool/result':
        role = 'Tool result';
        body = contentText(data['content']);
      case 'tool/call':
        role = 'Tool · ${data['name']}';
        body = data['arguments']?.toString() ?? '';
      default:
        return const SizedBox.shrink();
    }
    final user = role == 'You';
    final tool = role.startsWith('Tool');
    final marker = user ? body.indexOf(repositoryMarker) : -1;
    final width = MediaQuery.sizeOf(context).width;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.xl),
      child: Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: width > 850 ? 780 : width * .94,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                role,
                style: text.labelMedium?.copyWith(color: colors.secondary),
              ),
              const SizedBox(height: Space.xs),
              Container(
                padding: user
                    ? const EdgeInsets.symmetric(
                        horizontal: Space.l,
                        vertical: Space.m,
                      )
                    : EdgeInsets.zero,
                decoration: user
                    ? BoxDecoration(
                        color: colors.fill,
                        borderRadius: BorderRadius.circular(16),
                      )
                    : null,
                child: SelectableText(
                  body.isEmpty
                      ? '(Structured content)'
                      : user
                      ? body.split(repositoryMarker).first.trim()
                      : body,
                  style: tool ? text.bodySmall : text.bodyLarge,
                ),
              ),
              if (marker >= 0)
                ExpansionTile(
                  dense: true,
                  title: Text(
                    'Repository metadata included',
                    style: text.bodySmall,
                  ),
                  children: [CodeBlock(body.substring(marker))],
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget queueView() {
    final inbox = object(object(projections)['values'])['inbox'];
    final text = Theme.of(context).textTheme;
    final lanes = {
      for (final lane in ['next-step', 'next-turn'])
        lane: object(inbox)[lane] as List? ?? [],
    };
    return ListView(
      padding: const EdgeInsets.all(Space.l),
      children: [
        if (lanes.values.every((items) => items.isEmpty))
          quiet('Nothing queued')
        else
          for (final lane in lanes.keys) ...[
            Text(
              lane == 'next-step' ? 'Next step · priority' : 'Next turn',
              style: text.titleMedium,
            ),
            const SizedBox(height: Space.s),
            if (lanes[lane]!.isEmpty) Text('Empty', style: text.bodySmall),
            for (final raw in lanes[lane]!) queueCard(object(raw), lane),
            const SizedBox(height: Space.xl),
          ],
      ],
    );
  }

  Widget queueCard(JsonMap item, String lane) {
    final content = contentText(item['content']);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.l),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            content.split(repositoryMarker).first.trim(),
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
          ),
          if (content.contains(repositoryMarker))
            Text('Repository metadata included', style: text.bodySmall),
          if (owned)
            Wrap(
              spacing: Space.l,
              children: [
                TextButton(
                  style: edgeAction,
                  onPressed: busy ? null : () => changeQueue(item, 'edit'),
                  child: const Text('Edit message'),
                ),
                if (lane == 'next-turn')
                  TextButton(
                    style: edgeAction,
                    onPressed: busy ? null : () => changeQueue(item, 'steer'),
                    child: const Text('Prioritize next step'),
                  ),
                TextButton(
                  style: edgeAction,
                  onPressed: busy ? null : () => changeQueue(item, 'remove'),
                  child: const Text('Remove'),
                ),
              ],
            ),
          ExpansionTile(
            dense: true,
            title: Text('Details', style: text.bodySmall),
            children: [CodeBlock(pretty(item))],
          ),
        ],
      ),
    );
  }

  Widget liveView(List<RelayEvent> events) {
    final text = Theme.of(context).textTheme;
    if (events.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(Space.l),
        children: [quiet('No live events yet')],
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(Space.l),
      itemCount: events.length,
      itemBuilder: (context, index) {
        final event = events[index];
        return Padding(
          padding: const EdgeInsets.only(bottom: Space.l),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${event.kind} · ${event.createdAt.toLocal().toString().substring(11, 19)}',
                style: text.labelMedium?.copyWith(
                  color: HarnessColors.of(context).secondary,
                ),
              ),
              const SizedBox(height: Space.s),
              CodeBlock(pretty(event.payload)),
            ],
          ),
        );
      },
    );
  }

  Widget stateView() => ListView(
    padding: const EdgeInsets.all(Space.l),
    children: [
      if (projections == null)
        quiet('No snapshot loaded yet.')
      else
        CodeBlock(pretty(projections)),
    ],
  );

  Widget approvalPanel() {
    final requests = widget.store.pendingApprovals.values
        .where(
          (request) =>
              request['sessionId'] == widget.sessionId &&
              request['instanceId'] == widget.instanceId,
        )
        .toList();
    return Reveal(
      child: requests.isEmpty
          ? null
          : ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 220),
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(
                  Space.l,
                  Space.s,
                  Space.l,
                  0,
                ),
                children: [
                  for (final request in requests) approvalItem(request),
                ],
              ),
            ),
    );
  }

  Widget approvalItem(JsonMap request) {
    final text = Theme.of(context).textTheme;
    final colors = HarnessColors.of(context);
    final available = review(request)['toolArgumentsAvailable'] == true;
    return Container(
      margin: const EdgeInsets.only(bottom: Space.s),
      padding: const EdgeInsets.all(Space.l),
      decoration: BoxDecoration(
        color: colors.warningSurface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Approval needed: ${request['toolName']}',
            style: text.titleMedium,
          ),
          const SizedBox(height: Space.xs),
          Text(
            request['reason']?.toString() ??
                'Review the complete request before responding.',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: text.bodySmall,
          ),
          if (!available)
            Padding(
              padding: const EdgeInsets.only(top: Space.xs),
              child: Text(
                'Refresh history to load matching tool arguments before allowing.',
                style: text.bodySmall?.copyWith(color: colors.warningLabel),
              ),
            ),
          if (owned)
            Padding(
              padding: const EdgeInsets.only(top: Space.m),
              child: Wrap(
                spacing: Space.s,
                runSpacing: Space.s,
                children: [
                  FilledButton(
                    onPressed: busy || !available
                        ? null
                        : () => respond(request, true),
                    child: const Text('Review and allow'),
                  ),
                  TextButton(
                    onPressed: busy ? null : () => respond(request, false),
                    child: const Text('Reject'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget composer() {
    final store = widget.store;
    final colors = HarnessColors.of(context);
    final unresolved = store.hasUnresolvedWrite(widget.instanceId);
    return Container(
      decoration: BoxDecoration(
        color: colors.fill,
        borderRadius: BorderRadius.circular(24),
      ),
      padding: const EdgeInsets.fromLTRB(Space.s, Space.xs, Space.s, Space.xs),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Reveal(
            padding: const EdgeInsets.only(top: Space.xs),
            child: referenceIds.isEmpty
                ? null
                : SizedBox(
                    height: 40,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        for (final reference in references)
                          Padding(
                            padding: const EdgeInsets.only(right: Space.s),
                            child: InputChip(
                              label: Text(
                                '${reference.fullName}${reference.verified ? '' : ' · ${reference.localState}'}',
                                overflow: TextOverflow.ellipsis,
                              ),
                              onPressed: () =>
                                  showRepositoryPreview(context, [reference]),
                              onDeleted: () {
                                setState(
                                  () => referenceIds.remove(reference.id),
                                );
                                saveDraft();
                              },
                            ),
                          ),
                      ],
                    ),
                  ),
          ),
          Reveal(
            padding: const EdgeInsets.only(top: Space.xs),
            child: attachments.isEmpty
                ? null
                : SizedBox(
                    height: 40,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        for (final attachment in attachments)
                          Padding(
                            padding: const EdgeInsets.only(right: Space.s),
                            child: InputChip(
                              label: Text(
                                attachment['name']?.toString() ?? 'Attachment',
                              ),
                              onDeleted: busy
                                  ? null
                                  : () {
                                      setState(
                                        () => attachments.remove(attachment),
                                      );
                                      saveDraft();
                                    },
                            ),
                          ),
                      ],
                    ),
                  ),
          ),
          TextField(
            controller: prompt,
            minLines: 1,
            maxLines: 5,
            enabled: !busy,
            decoration: const InputDecoration(
              hintText: 'Message',
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              contentPadding: EdgeInsets.symmetric(
                horizontal: Space.s,
                vertical: Space.m,
              ),
            ),
            textInputAction: TextInputAction.newline,
          ),
          Row(
            children: [
              IconButton(
                tooltip: 'Upload attachment',
                onPressed: owned && !busy && !unresolved ? attach : null,
                icon: const Icon(Icons.add),
                iconSize: 22,
              ),
              IconButton(
                tooltip: 'Repository references',
                onPressed: repositories,
                icon: const Icon(Icons.account_tree_outlined),
                iconSize: 20,
              ),
              const SizedBox(width: Space.xs),
              Expanded(
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: promptMode,
                    style: Theme.of(context).textTheme.bodySmall,
                    borderRadius: BorderRadius.circular(12),
                    items: const [
                      DropdownMenuItem(value: 'queue', child: Text('Queue')),
                      DropdownMenuItem(
                        value: 'steer',
                        child: Text('Steer next step'),
                      ),
                    ],
                    onChanged: busy
                        ? null
                        : (value) {
                            setState(() => promptMode = value!);
                            saveDraft();
                          },
                  ),
                ),
              ),
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: prompt,
                builder: (context, value, _) => SendStopButton(
                  stop: running && value.text.trim().isEmpty,
                  onSend:
                      owned &&
                          !busy &&
                          !unresolved &&
                          repositorySelectionError(
                                references,
                                widget.instanceId,
                              ) ==
                              null
                      ? send
                      : null,
                  onStop: owned && !busy ? cancelOperation : null,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    final instance = store.instance(widget.instanceId);
    final text = Theme.of(context).textTheme;
    final events = store.events
        .where(
          (e) =>
              e.instanceId == widget.instanceId &&
              (object(e.payload)['sessionId'] == null ||
                  object(e.payload)['sessionId'] == widget.sessionId),
        )
        .toList();
    watchControl(context);
    return Scaffold(
      appBar: AppBar(
        leading: const BackButton(),
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(
                    instance?.name ?? 'Harness',
                    style: text.bodySmall,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: Space.s),
                Flexible(child: StatusDot.instance(store, instance)),
              ],
            ),
            Text(
              object(snapshot)['title']?.toString() ?? widget.sessionId,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
        actions: [
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
              if (value == 'commands') commandHistory();
              if (value == 'model') await model();
              if (value == 'settings') await settings();
              if (value == 'resume') {
                await run(() async {
                  await command('session.resume', {});
                });
              }
            },
            itemBuilder: (_) => [
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
            ],
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            BusyBar(busy: busy, onStop: stopWaiting),
            Reveal(
              padding: const EdgeInsets.fromLTRB(Space.l, Space.s, Space.l, 0),
              child: error == null
                  ? null
                  : ErrorNotice(
                      error!,
                      onDismiss: () => setState(() => error = null),
                    ),
            ),
            controlNotice(
              const EdgeInsets.fromLTRB(Space.l, Space.s, Space.l, 0),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.l, Space.s, Space.l, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Transform.translate(
                  offset: segmentEdgeOffset,
                  child: SegmentedButton<int>(
                    showSelectedIcon: false,
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
              ),
            ),
            Expanded(
              child: switch (tab) {
                0 => conversationView(),
                1 => liveView(events),
                2 => stateView(),
                _ => queueView(),
              },
            ),
            Reveal(
              padding: const EdgeInsets.fromLTRB(Space.l, 0, Space.l, Space.s),
              child: store.journalError == null
                  ? null
                  : ErrorNotice(store.journalError!),
            ),
            approvalPanel(),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                Space.l,
                Space.s,
                Space.l,
                Space.m,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 812),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Reveal(
                        child: showsControl
                            ? ControlButton(
                                state: controlState,
                                onPressed: controlReady ? toggleControl : null,
                              )
                            : null,
                      ),
                      Reveal(
                        padding: const EdgeInsets.only(top: Space.s),
                        child: store.hasUnresolvedWrite(widget.instanceId)
                            ? Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      'A write is unresolved. Query its original result.',
                                      style: text.bodySmall,
                                    ),
                                  ),
                                  TextButton(
                                    onPressed: commandHistory,
                                    child: const Text('Query result'),
                                  ),
                                ],
                              )
                            : null,
                      ),
                      const SizedBox(height: Space.s),
                      composer(),
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

void message(BuildContext context, String text) =>
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

Future<bool> confirmDialog(
  BuildContext context,
  String title,
  String detail,
  String action, {
  bool code = false,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => plainDialog(
        title: Text(title),
        content: SingleChildScrollView(
          child: code ? CodeBlock(detail) : Text(detail),
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Back'),
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
    builder: (context) => plainDialog(
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
        FilledButton(
          onPressed: () {
            if (controller.text.trim().isNotEmpty) {
              Navigator.pop(context, controller.text.trim());
            }
          },
          child: const Text('Continue'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
      ],
    ),
  );
  // The closing route may still use the text controller during its reverse transition.
  Future<void>.delayed(const Duration(seconds: 1), controller.dispose);
  return result;
}

/// This device's commands and restored unresolved operations, shown both as
/// a fleet section and as a page reachable from a session.
class CommandHistoryView extends StatelessWidget {
  const CommandHistoryView({
    required this.store,
    this.showJournalError = true,
    super.key,
  });
  final RemoteStore store;
  final bool showJournalError;

  Future<void> query(BuildContext context, RemoteCommand command) async {
    try {
      await store.checkCommand(command.id);
    } catch (e) {
      if (context.mounted) {
        await showDialog<void>(
          context: context,
          builder: (c) => plainDialog(
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
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      final text = Theme.of(context).textTheme;
      final colors = HarnessColors.of(context);
      final error = Theme.of(context).colorScheme.error;
      return ListView(
        padding: const EdgeInsets.fromLTRB(
          Space.l,
          Space.s,
          Space.l,
          Space.xxxl,
        ),
        children: [
          Text('Command history', style: text.headlineMedium),
          const SizedBox(height: Space.s),
          Text(
            'Unknown results are never resent automatically. If a result is missing, query the original command again instead of sending a new one.',
            style: text.bodySmall,
          ),
          if (showJournalError)
            Reveal(
              padding: const EdgeInsets.only(top: Space.l),
              child: store.journalError == null
                  ? null
                  : ErrorNotice(store.journalError!),
            ),
          const SizedBox(height: Space.xl),
          if (store.commands.isEmpty)
            Text(
              'No commands in this login session.',
              style: text.bodyMedium?.copyWith(color: colors.secondary),
            ),
          for (final command in store.commands.values.toList().reversed)
            ExpansionTile(
              title: Text(command.json['action']?.toString() ?? command.id),
              subtitle: Text(
                command.status,
                style: text.bodySmall?.copyWith(
                  color: switch (command.status) {
                    'indeterminate' => colors.warningLabel,
                    'failed' => error,
                    _ => colors.secondary,
                  },
                ),
              ),
              children: [
                CodeBlock(pretty(command.json)),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    style: edgeAction,
                    onPressed: () => query(context, command),
                    child: const Text('Query original result'),
                  ),
                ),
              ],
            ),
          const SizedBox(height: Space.l),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              style: edgeAction,
              onPressed: store.restoreCommandJournal,
              child: const Text('Reload saved command journal'),
            ),
          ),
        ],
      );
    },
  );
}

class CommandHistoryPage extends StatelessWidget {
  const CommandHistoryPage({required this.store, super.key});
  final RemoteStore store;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(),
    body: CommandHistoryView(store: store),
  );
}
