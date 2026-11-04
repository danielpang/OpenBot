import {
  createClient,
  createWsClient,
  unwrap,
  type Client,
  type WsClient,
  type components,
} from '@openbots/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState, Platform, View, Text, Pressable, StyleSheet } from 'react-native';
import { router, type Href } from 'expo-router';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { HostStore } from '../hosts/store';
import { createSecureHostStorage } from '../hosts/secure-store';
import { pairHost, parsePairingLink } from '../hosts/pairing';
import type { SavedHost } from '../hosts/types';
import { connectHost, normalizeServerUrl, type MobileTransport } from '../transport';
import { TransportLifecycle } from '../transport/lifecycle';
import { createMemoryCache, type SnapshotCache } from '../cache';
import { createSqliteCache } from '../cache/sqlite';
import { AppLockPolicy, authenticateOwner } from '../native/appLock';
import { setSharedPushKey, removeSharedPushKey } from '../native/pushKey';
import {
  installPushHandlers,
  registerDevicePush,
  uploadDevicePushToken,
} from '../push/notifications';
import { uploadAttachment, openFile, type Attachment } from './files';
import { signInAndPair } from './sign-in';
import { cacheBotNotificationAvatars, forgetNotificationAvatars } from '../push/avatars';
import { withSubscriptionCounts } from './subscriptions';
import { MobileNotices } from '../notices';
import { ownerHandles, type Notice } from '@openbots/shared';

const hosts = new HostStore(createSecureHostStorage());
const lockPolicy = new AppLockPolicy();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
type Resync = () => void;

export interface MobileContextValue {
  host: SavedHost | null;
  hosts: readonly SavedHost[];
  ready: boolean;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  client: Client | null;
  transport: MobileTransport | null;
  ws: WsClient | null;
  cache: SnapshotCache;
  lockEnabled: boolean;
  notificationsEnabled: boolean;
  connectAddress(
    address: string,
    apiKey: string,
    name?: string,
    kind?: 'server' | 'account',
  ): Promise<void>;
  signIn(
    address: string,
    email: string,
    password: string,
    name?: string,
    kind?: 'server' | 'account',
  ): Promise<void>;
  pair(link: string, name: string, ownerName?: string): Promise<{ setupNeeded: boolean }>;
  activateHost(id: string): Promise<void>;
  removeHost(id: string): Promise<void>;
  refresh(): void;
  uploadAttachment(attachment: Attachment): Promise<components['schemas']['File']>;
  openFile(id: string, name: string): Promise<void>;
  onResync(chatId: string, listener: Resync): () => void;
  setFocusedChat(chatId: string | null): void;
  setLockEnabled(value: boolean): Promise<void>;
  enableNotifications(): Promise<string>;
}
const MobileContext = createContext<MobileContextValue | null>(null);
export function useMobile() {
  const value = useContext(MobileContext);
  if (!value) throw new Error('MobileProvider is missing');
  return value;
}
export function useApi() {
  const { client } = useMobile();
  if (!client) throw new Error('Connect to a server first');
  return client;
}

export function MobileProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(hosts.subscribe, hosts.getSnapshot);
  const host = snapshot.hosts.find((entry) => entry.id === snapshot.activeHostId) ?? null;
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 15_000 }, mutations: { retry: false } },
      }),
    [host?.id],
  );
  const [cache, setCache] = useState<SnapshotCache>(() => createMemoryCache());
  const [ready, setReady] = useState(false);
  const [savedTransport, setTransport] = useState<MobileTransport | null>(null);
  const [savedWs, setWs] = useState<WsClient | null>(null);
  const [connectionHostId, setConnectionHostId] = useState<string | null>(null);
  // A new host renders before the previous host's passive effects dispose.
  // Never let that render expose the previous host's authenticated transport.
  const transport = connectionHostId === host?.id ? savedTransport : null;
  const ws = connectionHostId === host?.id ? savedWs : null;
  const [connecting, setConnecting] = useState(false);
  const [savedConnected, setConnected] = useState(false);
  const connected = savedConnected && connectionHostId === host?.id;
  const [bannerEntry, setBannerEntry] = useState<{ hostId: string | null; notice: Notice } | null>(
    null,
  );
  const banner = bannerEntry?.hostId === host?.id ? (bannerEntry?.notice ?? null) : null;
  const setBanner = (notice: Notice | null) =>
    setBannerEntry(notice ? { hostId: host?.id ?? null, notice } : null);
  const [error, setError] = useState<string | null>(null);
  const [lockEnabled, setLockState] = useState(true);
  const [locked, setLocked] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [revision, setRevision] = useState(0);
  const [notificationsEnabled, setNotifications] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);
  const listeners = useRef(new Map<string, Set<Resync>>());
  const focusedChat = useRef<string | null>(null);
  const latest = useRef({ host, transport, locked, lockEnabled });
  latest.current = { host, transport, locked, lockEnabled };
  const client = useMemo(
    () =>
      host
        ? createClient(
            transport?.baseUrl ?? host.directUrls[0] ?? 'https://openbots.tunnel',
            transport?.fetch ??
              ((async () => {
                throw new Error('You’re offline. Reconnect to refresh this conversation.');
              }) as typeof fetch),
          )
        : null,
    [host?.id, transport],
  );
  const notices = useMemo(
    () =>
      new MobileNotices(() => {
        const me = queryClient.getQueryData<{ user: { name: string; email: string } }>(['me']);
        return {
          botName: (id) =>
            queryClient
              .getQueryData<{ items: components['schemas']['Bot'][] }>(['bots'])
              ?.items.find((bot) => bot.id === id)?.name,
          ownerHandles: me ? ownerHandles(me.user) : [],
        };
      }, setBanner),
    [host?.id, queryClient],
  );
  useEffect(() => {
    setBanner(null);
    setNotifications(false);
    notices.setForegroundChat(focusedChat.current);
  }, [notices]);
  useEffect(
    () => () => {
      void cache.close();
    },
    [cache],
  );
  const environment =
    Constants.expoConfig?.extra?.apnsEnvironment === 'production' ? 'production' : 'sandbox';

  useEffect(() => {
    let disposed = false;
    void (async () => {
      await hosts.load();
      const pref = await SecureStore.getItemAsync('openbots.lock');
      if (disposed) return;
      setLockState(pref !== 'false');
      setLocked(pref !== 'false' && hosts.getSnapshot().hosts.length > 0);
      try {
        const db = await createSqliteCache();
        if (disposed) await db.close();
        else setCache(db);
      } catch {
        setError('Offline storage is unavailable. Connected conversations still work.');
      }
      setReady(true);
    })().catch((cause) => {
      if (!disposed) {
        setError(errorText(cause));
        setReady(true);
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  const unlock = async () => {
    if (unlocking) return;
    setUnlocking(true);
    try {
      if (await authenticateOwner()) {
        lockPolicy.unlock();
        setLocked(false);
        setError(null);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUnlocking(false);
    }
  };
  useEffect(() => {
    if (ready && locked && lockEnabled && host) void unlock();
  }, [ready]); // launch only
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const foreground = state === 'active';
      if (!foreground) lockPolicy.background();
      else if (lockPolicy.foreground() && latest.current.lockEnabled && latest.current.host)
        setLocked(true);
      setActive(foreground);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!ready || !host || (lockEnabled && locked)) return;
    let socket: WsClient | null = null;
    let stopped = false;
    let connectionEpoch = 0;
    let unsubscribeRoster: (() => void) | undefined;
    const lifecycle = new TransportLifecycle({
      connect: async (signal) => {
        setConnecting(true);
        return connectHost(host, await hosts.secrets(host.id), { signal });
      },
      onConnected(next) {
        if (stopped) return;
        const epoch = ++connectionEpoch;
        const valid = () => !stopped && epoch === connectionEpoch;
        setConnectionHostId(host.id);
        setTransport(next);
        setError(null);
        setConnecting(false);
        socket = withSubscriptionCounts(
          createWsClient({
            url: `${next.baseUrl.replace(/^http/, 'ws')}/ws`,
            createSocket: next.createSocket,
            onStatus(status) {
              if (!valid()) return;
              setConnected(status === 'open');
              if (status === 'closed' && socket) lifecycle.reconnect();
            },
            onResync(chatId) {
              for (const listener of listeners.current.get(chatId) ?? []) listener();
            },
          }),
        );
        socket.onEvent((event) => {
          if (!valid()) return;
          const notice = notices.onEvent(event);
          if (notice?.kind === 'question' || event.type === 'message.deleted')
            void queryClient.invalidateQueries({ queryKey: ['inbox'] });
          if (event.type === 'bot.state') {
            queryClient.setQueryData<{ items: components['schemas']['Bot'][] }>(
              ['bots'],
              (old) =>
                old && {
                  ...old,
                  items: old.items.map((bot) =>
                    bot.id === event.payload.botId
                      ? {
                          ...bot,
                          state: {
                            ...bot.state,
                            ...event.payload,
                            updatedAt: new Date(event.ts).toISOString(),
                          },
                        }
                      : bot,
                  ),
                },
            );
          } else if (event.type === 'device.revoked' && event.payload.device.id === host.deviceId) {
            void hosts
              .remove(host.id)
              .then(async () => {
                await cache.removeHost(host.id);
                await removeSharedPushKey(host.id).catch(() => {});
              })
              .catch((cause) => setError(errorText(cause)));
          } else if (/^(approval|widget)\./.test(event.type)) {
            void queryClient.invalidateQueries({ queryKey: ['inbox'] });
            void queryClient.invalidateQueries({ queryKey: ['messages'] });
            void queryClient.invalidateQueries({ queryKey: ['approvals'] });
          } else if (/^(artifact|routine|run)\./.test(event.type)) {
            void queryClient.invalidateQueries({
              predicate: (query) =>
                ['bot-artifacts', 'artifacts', 'routines', 'runs'].includes(
                  String(query.queryKey[0]),
                ),
            });
          }
        });
        setWs(socket);
        const api = createClient(next.baseUrl, next.fetch);
        void unwrap(api.GET('/api/v1/bots'))
          .then((result) => {
            if (!valid()) return;
            queryClient.setQueryData(['bots'], result);
            void cacheBotNotificationAvatars(next.fetch, host.id, result.items).catch(() => {});
          })
          .catch((cause) => {
            if (valid()) setError(errorText(cause));
          });
        void unwrap(api.GET('/api/v1/me'))
          .then((result) => {
            if (valid()) queryClient.setQueryData(['me'], result);
          })
          .catch(() => {});
        void unwrap(api.GET('/api/v1/chats'))
          .then((result) => {
            if (valid()) queryClient.setQueryData(['chats'], result);
          })
          .catch(() => {});
        const retainedBots = new Set<string>();
        const retainedChats = new Set<string>();
        const syncRoster = () => {
          if (!valid() || !socket) return;
          const bots =
            queryClient.getQueryData<{ items: components['schemas']['Bot'][] }>(['bots'])?.items ??
            [];
          const groups =
            queryClient.getQueryData<{ items: components['schemas']['Chat'][] }>(['chats'])
              ?.items ?? [];
          const nextBots = new Set(bots.map((bot) => bot.id));
          const nextChats = new Set([
            ...bots.map((bot) => bot.chatId),
            ...groups.map((chat) => chat.id),
          ]);
          socket.subscribe({
            bots: [...nextBots].filter((id) => !retainedBots.has(id)),
            chats: [...nextChats].filter((id) => !retainedChats.has(id)),
          });
          socket.unsubscribe({
            bots: [...retainedBots].filter((id) => !nextBots.has(id)),
            chats: [...retainedChats].filter((id) => !nextChats.has(id)),
          });
          retainedBots.clear();
          for (const id of nextBots) retainedBots.add(id);
          retainedChats.clear();
          for (const id of nextChats) retainedChats.add(id);
        };
        unsubscribeRoster = queryClient.getQueryCache().subscribe((event) => {
          if (
            event.type === 'updated' &&
            ['bots', 'chats'].includes(String(event.query.queryKey[0]))
          )
            syncRoster();
        });
        syncRoster();
        void queryClient.invalidateQueries();
        for (const callbacks of listeners.current.values())
          for (const callback of callbacks) callback();
      },
      onDisconnected() {
        connectionEpoch++;
        unsubscribeRoster?.();
        unsubscribeRoster = undefined;
        const old = socket;
        socket = null;
        // Prevent a deliberate close from recursively scheduling a reconnect.
        old?.close();
        if (!stopped) {
          setConnectionHostId(null);
          setWs(null);
          setTransport(null);
          setConnected(false);
        }
      },
      onError(cause) {
        if (!stopped) {
          setError(errorText(cause));
          setConnecting(false);
        }
      },
    });
    lifecycle.setActive(active);
    return () => {
      stopped = true;
      lifecycle.close();
      setWs(null);
      setTransport(null);
      setConnected(false);
    };
  }, [host?.id, ready, active, locked, lockEnabled, revision, queryClient, cache, notices]);

  useEffect(() => {
    if (!ready) return;
    return installPushHandlers({
      pushKeys: async () =>
        Promise.all(
          hosts.getSnapshot().hosts.map(async (saved) => ({
            hostId: saved.id,
            pushKey: (await hosts.secrets(saved.id)).pushKey ?? '',
          })),
        ),
      focusedChat: () =>
        latest.current.host
          ? { hostId: latest.current.host.id, chatId: focusedChat.current }
          : null,
      activateHost: async (id) => {
        if (!hosts.getSnapshot().hosts.some((saved) => saved.id === id)) return false;
        if (latest.current.lockEnabled && !(await authenticateOwner())) return false;
        lockPolicy.unlock();
        setLocked(false);
        await hosts.activate(id);
        return true;
      },
      fetchForHost: async (id) => {
        const saved = hosts.getSnapshot().hosts.find((item) => item.id === id);
        if (!saved) throw new Error('This host was removed.');
        // Notification actions are single requests; never leave a background tunnel open.
        return async (path, init) => {
          const temporary = await connectHost(saved, await hosts.secrets(id));
          try {
            const response = await temporary.fetch(path, init);
            const bytes = await response.arrayBuffer();
            return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
              status: response.status,
              headers: response.headers,
            });
          } finally {
            temporary.close();
          }
        };
      },
      navigate: (route) => setPendingRoute(route),
      onError: (cause) => setError(errorText(cause)),
      tokenChanged: async (token) => {
        for (const saved of hosts.getSnapshot().hosts) {
          if (!saved.deviceId) continue;
          const temporary = await connectHost(saved, await hosts.secrets(saved.id));
          try {
            await uploadDevicePushToken(temporary.fetch, saved.deviceId, environment, token);
          } finally {
            temporary.close();
          }
        }
      },
    });
  }, [ready, environment]);

  // Defer cold-start push routing until the unlocked navigator has mounted.
  useEffect(() => {
    if (!pendingRoute || !ready || !host || (lockEnabled && locked)) return;
    router.push(pendingRoute as Href);
    setPendingRoute(null);
  }, [pendingRoute, ready, host?.id, lockEnabled, locked]);

  // Persist only conversation metadata; keys and credential-bearing URLs never enter SQLite.
  useEffect(() => {
    if (!host) return;
    let disposed = false;
    let pending = Promise.resolve();
    const keys = ['bots', 'chats', 'approvals'];
    for (const key of keys)
      void cache
        .get(host.id, `query:${key}`)
        .then((data) => {
          if (!disposed && data && !queryClient.getQueryData([key]))
            queryClient.setQueryData([key], data);
        })
        .catch(() => {});
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== 'updated' ||
        !keys.includes(String(event.query.queryKey[0])) ||
        event.query.state.status !== 'success'
      )
        return;
      const key = String(event.query.queryKey[0]);
      const data = event.query.state.data;
      pending = pending
        .then(() => (disposed ? undefined : cache.set(host.id, `query:${key}`, data)))
        .catch(() => {});
    });
    return () => {
      disposed = true;
      unsubscribe();
      void queryClient.cancelQueries();
      queryClient.clear();
    };
  }, [host?.id, cache, queryClient]);

  const value: MobileContextValue = {
    host,
    hosts: snapshot.hosts,
    ready,
    connected,
    connecting,
    error,
    client,
    transport,
    ws,
    cache,
    lockEnabled,
    notificationsEnabled,
    async connectAddress(address, apiKey, name, kind = 'server') {
      const origin = normalizeServerUrl(address);
      const saved: SavedHost = {
        id: `${kind}-${origin}`,
        name: name?.trim() || new URL(origin).hostname,
        kind,
        directUrls: [origin],
        relayUrl: null,
      };
      const connection = await connectHost(saved, { apiKey: apiKey.trim() });
      try {
        const me = await unwrap(
          createClient(connection.baseUrl, connection.fetch).GET('/api/v1/me'),
        );
        saved.ownerId = me.user.id;
      } finally {
        connection.close();
      }
      lockPolicy.unlock();
      setLocked(false);
      await hosts.save(saved, { apiKey: apiKey.trim() });
    },
    async signIn(
      address,
      email,
      password,
      name = Platform.OS === 'ios' ? 'My iPhone' : 'My phone',
      kind = 'server',
    ) {
      const result = await signInAndPair({ address, email, password, deviceName: name });
      result.host.kind = kind;
      await hosts.save(result.host, result.secrets);
      lockPolicy.unlock();
      setLocked(false);
      await setSharedPushKey(result.host.id, result.secrets.pushKey!).catch((cause) =>
        setError(`Connected. Notifications require a native build: ${errorText(cause)}`),
      );
    },
    async pair(link, name, ownerName) {
      const result = await pairHost(parsePairingLink(link), { deviceName: name, ownerName });
      await hosts.save(result.host, result.secrets);
      lockPolicy.unlock();
      setLocked(false);
      try {
        await setSharedPushKey(result.host.id, result.secrets.pushKey!);
      } catch (cause) {
        setError(`Paired successfully. Notifications need a native build: ${errorText(cause)}`);
      }
      return { setupNeeded: result.setupNeeded };
    },
    activateHost: (id) => hosts.activate(id),
    async removeHost(id) {
      forgetNotificationAvatars(id);
      await hosts.remove(id);
      await cache.removeHost(id);
      await removeSharedPushKey(id).catch(() => {});
    },
    refresh: () => setRevision((number) => number + 1),
    uploadAttachment: (attachment) => {
      if (!transport) return Promise.reject(new Error('Reconnect before uploading.'));
      return uploadAttachment(transport, attachment);
    },
    openFile: (id, name) => {
      if (!transport) return Promise.reject(new Error('Reconnect before downloading.'));
      return openFile(transport, id, name);
    },
    onResync(chatId, listener) {
      const set = listeners.current.get(chatId) ?? new Set<Resync>();
      set.add(listener);
      listeners.current.set(chatId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.current.delete(chatId);
      };
    },
    setFocusedChat: (chatId) => {
      focusedChat.current = chatId;
      notices.setForegroundChat(chatId);
      if (chatId) notices.markChatRead(chatId);
    },
    async setLockEnabled(enabled) {
      if (!(await authenticateOwner())) return;
      await SecureStore.setItemAsync('openbots.lock', String(enabled));
      setLockState(enabled);
      lockPolicy.unlock();
      setLocked(false);
    },
    async enableNotifications() {
      if (!host?.deviceId || !transport)
        throw new Error('Pair this device and connect before enabling notifications.');
      const secrets = await hosts.secrets(host.id);
      if (!secrets.pushKey)
        throw new Error('Pair this device again to enable encrypted notifications.');
      await setSharedPushKey(host.id, secrets.pushKey);
      const result = await registerDevicePush(transport.fetch, host.deviceId, environment);
      setNotifications(result === 'registered');
      return result;
    },
  };
  return (
    <MobileContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>
        {ready && host && lockEnabled && locked ? (
          <View style={styles.lock}>
            <Text style={styles.title}>OpenBots is locked</Text>
            <Text style={styles.description}>Unlock to open your conversations.</Text>
            {error ? <Text style={styles.description}>{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              disabled={unlocking}
              onPress={() => void unlock()}
              style={styles.button}
            >
              <Text style={styles.label}>{unlocking ? 'Unlocking…' : 'Unlock OpenBots'}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ flex: 1 }} key={host?.id ?? 'onboarding'}>
            {children}
            {banner && active ? (
              <View style={styles.banner} accessibilityLiveRegion="polite">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${banner.title}. ${banner.body}`}
                  onPress={() => {
                    const target = banner.target;
                    setBanner(null);
                    if (target.chatId)
                      router.push({
                        pathname: '/chat/[id]',
                        params: {
                          id: target.chatId,
                          seq: String(target.seq ?? ''),
                          thread: target.threadRootId ?? '',
                        },
                      });
                    else router.push(`/bot/${target.botId}` as Href);
                  }}
                  style={{ flex: 1, gap: 4 }}
                >
                  <Text style={styles.bannerTitle}>{banner.title}</Text>
                  <Text style={styles.bannerBody} numberOfLines={2}>
                    {banner.body}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss notification"
                  onPress={() => setBanner(null)}
                  style={{ padding: 10 }}
                >
                  <Text style={styles.bannerTitle}>×</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}
      </QueryClientProvider>
    </MobileContext.Provider>
  );
}
const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 90,
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#26374b',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerTitle: { color: '#f5f7fa', fontSize: 16, fontWeight: '600' },
  bannerBody: { color: '#c0cad8', fontSize: 14 },
  lock: { flex: 1, justifyContent: 'center', padding: 32, backgroundColor: '#131920', gap: 18 },
  title: { fontSize: 28, color: '#f5f7fa', fontWeight: '700' },
  description: { fontSize: 17, color: '#a9b6c5' },
  button: { padding: 18, backgroundColor: '#d0e0ff', borderRadius: 14 },
  label: { fontWeight: '600', textAlign: 'center', color: '#172438', fontSize: 17 },
});
