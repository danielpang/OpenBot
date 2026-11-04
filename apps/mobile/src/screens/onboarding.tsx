import { useMemo, useRef, useState } from 'react';
import { Alert, Image, Linking, Platform, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Constants from 'expo-constants';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useMobile } from '../api/provider';
import { parsePairingLink } from '../hosts/pairing';
import { parseConnectionQr } from '../hosts/connection-qr';
import { Button, Card, Empty, ErrorNote, Field, Icon, Label, Page } from '../components/ui';

const cloudUrl =
  typeof Constants.expoConfig?.extra?.cloudUrl === 'string'
    ? Constants.expoConfig.extra.cloudUrl
    : undefined;
export function WelcomeScreen() {
  const [, requestCameraPermission, getCameraPermission] = useCameraPermissions();
  const [requestingCamera, setRequestingCamera] = useState(false);
  const cameraRequestInFlight = useRef(false);

  async function openScanner() {
    if (cameraRequestInFlight.current) return;
    cameraRequestInFlight.current = true;
    setRequestingCamera(true);
    try {
      const current = await getCameraPermission();
      if (current.granted) {
        router.push('/(onboarding)/pair');
      } else if (current.canAskAgain) {
        const result = await requestCameraPermission();
        if (result.granted) router.push('/(onboarding)/pair');
      } else {
        Alert.alert(
          'Camera access is disabled',
          'You can enter your server URL manually, or allow camera access in Settings to scan a QR code.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: () => {
                void Linking.openSettings().catch(() => {
                  Alert.alert('Open Settings manually', 'Go to Settings → OpenBots → Camera.');
                });
              },
            },
          ],
        );
      }
    } catch {
      Alert.alert('Camera unavailable', 'Please enter your server URL manually or try again.');
    } finally {
      cameraRequestInFlight.current = false;
      setRequestingCamera(false);
    }
  }
  return (
    <Page style={{ paddingTop: 64 }}>
      <View style={{ gap: 22, paddingBottom: 26 }}>
        <View style={{ alignItems: 'center', gap: 14 }}>
          <Image
            // Metro resolves bundled image assets with a static require.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            source={require('../../assets/openbots-logo.png')}
            accessibilityLabel="OpenBots logo"
            accessibilityRole="image"
            resizeMode="contain"
            style={{ width: 70, height: 70 }}
          />
          <Label size={38} weight="700" style={{ letterSpacing: -1.5, textAlign: 'center' }}>
            OpenBots
          </Label>
        </View>
        <Label size={18} muted>
          Welcome to OpenBots. Connect to OpenBots on your computer or your server.
        </Label>
      </View>
      <Card>
        <Label size={20} weight="600">
          Pair your phone
        </Label>
        <Label muted>
          Open OpenBots on your computer and choose “Pair your phone”. Then scan its QR code.
        </Label>
        <Button
          title="Scan a QR code"
          icon="qr-code-outline"
          loading={requestingCamera}
          onPress={() => void openScanner()}
        />
      </Card>
      <Button
        title="Enter manually"
        variant="secondary"
        icon="server-outline"
        onPress={() => router.push('/(onboarding)/connect')}
      />
    </Page>
  );
}

export function ConnectScreen() {
  const { kind, address: scannedAddress } = useLocalSearchParams<{
    kind?: string;
    address?: string;
  }>();
  const account = kind === 'account';
  const [address, setAddress] = useState(account ? (cloudUrl ?? '') : (scannedAddress ?? ''));
  const [mode, setMode] = useState<'signin' | 'key'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mobile = useMobile();
  async function connect() {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin')
        await mobile.signIn(
          address.trim(),
          email.trim(),
          password,
          name.trim() || undefined,
          account ? 'account' : 'server',
        );
      else
        await mobile.connectAddress(
          address.trim(),
          key.trim(),
          name.trim() || undefined,
          account ? 'account' : 'server',
        );
      router.replace('/(tabs)/bots');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <Label size={30} weight="700">
        {account ? 'Sign in to OpenBots' : 'Enter manually'}
      </Label>
      <Label muted>
        {mode === 'signin'
          ? 'Sign in with your server account. A device API key will be stored in this phone’s Keychain.'
          : 'Enter a server API key. Your key is stored in this phone’s Keychain.'}
      </Label>
      {account && !cloudUrl ? (
        <ErrorNote error="OpenBots account sign-in is not configured in this build." />
      ) : null}
      <View style={{ gap: 12 }}>
        <Label weight="600">Server address</Label>
        <Field
          accessibilityLabel="Server address"
          placeholder="https://openbots.example.com"
          value={address}
          onChangeText={setAddress}
          editable={!busy && !account}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        {mode === 'signin' ? (
          <>
            <Label weight="600">Email</Label>
            <Field
              accessibilityLabel="Email"
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              autoComplete="email"
            />
            <Label weight="600">Password</Label>
            <Field
              accessibilityLabel="Password"
              placeholder="Your password"
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              autoComplete="current-password"
            />
          </>
        ) : (
          <>
            <Label weight="600">API key</Label>
            <Field
              accessibilityLabel="API key"
              placeholder="Paste your API key"
              value={key}
              onChangeText={setKey}
              editable={!busy}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </>
        )}
        <Label weight="600">Server name · optional</Label>
        <Field
          accessibilityLabel="Server name"
          placeholder="My OpenBots"
          value={name}
          onChangeText={setName}
          editable={!busy}
        />
      </View>
      <ErrorNote error={error} />
      <Button
        title={mode === 'signin' ? 'Sign in securely' : 'Connect securely'}
        loading={busy}
        disabled={
          !address.trim() ||
          (account && !cloudUrl) ||
          (mode === 'signin' ? !email.trim() || !password : !key.trim())
        }
        onPress={() => void connect()}
      />
      <Button
        title={mode === 'signin' ? 'Use an API key instead' : 'Sign in with email instead'}
        variant="ghost"
        disabled={busy}
        onPress={() => {
          setMode(mode === 'signin' ? 'key' : 'signin');
          setError(null);
        }}
      />
    </Page>
  );
}

export function PairScreen() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(link ?? '');
  const [deviceName, setDeviceName] = useState(Platform.OS === 'ios' ? 'My iPhone' : 'My phone');
  const [ownerName, setOwnerName] = useState('');
  const [manual, setManual] = useState(false);
  const scanHandled = useRef(false);
  function handleScan(data: string) {
    if (scanHandled.current) return;
    scanHandled.current = true;
    try {
      const destination = parseConnectionQr(data);
      if (destination.kind === 'server') {
        router.replace({
          pathname: '/(onboarding)/connect',
          params: { address: destination.address },
        });
      } else setScanned(destination.link);
    } catch (cause) {
      setError(cause);
    }
  }
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mobile = useMobile();
  const parsed = useMemo(() => {
    if (!scanned.trim()) return { value: null, error: null };
    try {
      return { value: parsePairingLink(scanned.trim()), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [scanned]);
  async function pair() {
    if (!parsed.value) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mobile.pair(
        scanned.trim(),
        deviceName.trim(),
        parsed.value.setup ? ownerName.trim() : undefined,
      );
      if (result.setupNeeded)
        Alert.alert(
          'Finish setup on your computer',
          'Your phone is paired. Complete the initial server setup on your computer to create your first Bot.',
        );
      router.replace('/(tabs)/bots');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <Label size={30} weight="700">
        Pair your phone
      </Label>
      {!scanned && !manual ? (
        <>
          <Label muted>
            Scan an OpenBots pairing code or a QR code containing your server’s HTTPS URL.
          </Label>
          <ErrorNote error={error} />
          {error ? (
            <Button
              title="Try another code"
              variant="ghost"
              onPress={() => {
                scanHandled.current = false;
                setError(null);
              }}
            />
          ) : null}
          {permission?.granted ? (
            <View style={{ height: 310, borderRadius: 24, overflow: 'hidden' }}>
              <CameraView
                style={{ flex: 1 }}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => handleScan(data)}
              />
            </View>
          ) : (
            <Empty
              icon="camera-outline"
              title="Enable your camera"
              detail="Camera access lets OpenBots scan your pairing code."
              action={<Button title="Allow camera" onPress={() => void requestPermission()} />}
            />
          )}
          <Button title="Paste a pairing link" variant="ghost" onPress={() => setManual(true)} />
        </>
      ) : (
        <>
          {manual ? (
            <Field
              accessibilityLabel="Pairing link"
              placeholder="openbots://pair#v=1&…"
              value={scanned}
              onChangeText={setScanned}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
          ) : null}
          {parsed.value ? (
            <Card>
              <Icon name="link-outline" />
              <Label weight="600" size={20}>
                {parsed.value.name}
              </Label>
              <Label muted>This code grants your phone access to this OpenBots server.</Label>
              <Label size={13} weight="600">
                Connection options
              </Label>
              {parsed.value.direct
                .filter((address) => address.startsWith('https:'))
                .map((address) => (
                  <Label key={address} muted size={13}>
                    Direct · {new URL(address).host}
                  </Label>
                ))}
              {parsed.value.relay ? (
                <Label muted size={13}>
                  Encrypted relay · {new URL(parsed.value.relay).host}
                </Label>
              ) : null}
              {!parsed.value.relay &&
              !parsed.value.direct.some((address) => address.startsWith('https:')) ? (
                <ErrorNote error="This code only offers an insecure local address. Enable a secure relay or HTTPS on your server, then scan a new code." />
              ) : null}
            </Card>
          ) : null}
          <ErrorNote error={parsed.error} />
          {parsed.value?.setup ? (
            <>
              <Label weight="600">Your name</Label>
              <Field
                accessibilityLabel="Owner name"
                placeholder="Your name"
                value={ownerName}
                onChangeText={setOwnerName}
                editable={!busy}
                autoComplete="name"
              />
              <Label muted size={13}>
                You’ll be the owner of this new OpenBots server.
              </Label>
            </>
          ) : null}
          <Label weight="600">This device’s name</Label>
          <Field
            accessibilityLabel="Device name"
            value={deviceName}
            onChangeText={setDeviceName}
            editable={!busy}
            maxLength={100}
          />
          <ErrorNote error={error} />
          <Button
            title="Pair with OpenBots"
            loading={busy}
            disabled={
              !parsed.value ||
              !deviceName.trim() ||
              (parsed.value.setup && !ownerName.trim()) ||
              (!parsed.value.relay &&
                !parsed.value.direct.some((address) => address.startsWith('https:')))
            }
            onPress={() => void pair()}
          />
          <Button
            title="Scan another code"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              scanHandled.current = false;
              setScanned('');
              setManual(false);
              setError(null);
            }}
          />
        </>
      )}
    </Page>
  );
}
