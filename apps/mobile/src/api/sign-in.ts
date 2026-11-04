import { createAuthClient, createClient, unwrap } from '@openbots/api-client';
import { normalizeServerUrl } from '../transport';
import { pairHost, parsePairingLink } from '../hosts/pairing';

/** Use the native session cookie only to mint a one-use device pairing. The
 * password and session never enter the host store; all later traffic uses the
 * independently revocable device key, including APNs registration. */
export async function signInAndPair(
  input: {
    address: string;
    email: string;
    password: string;
    deviceName: string;
  },
  fetchImpl: typeof fetch = fetch,
) {
  const origin = normalizeServerUrl(input.address);
  const auth = createAuthClient(origin, fetchImpl);
  await auth.signInEmail({ email: input.email.trim(), password: input.password });
  try {
    const api = createClient(origin, fetchImpl);
    const offer = await unwrap(
      api.POST('/api/v1/devices/pairings', {
        body: { name: input.deviceName, direct: [origin] },
      }),
    );
    return await pairHost(parsePairingLink(offer.link), {
      deviceName: input.deviceName,
      fetch: fetchImpl,
    });
  } finally {
    // Device credentials are independent of the short-lived sign-in cookie.
    await auth.signOut().catch(() => {});
  }
}
