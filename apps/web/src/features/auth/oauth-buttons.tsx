import type { SocialProvider } from '@openbots/api-client';
import { Button } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { auth, capabilitiesQuery } from '../../app/api.js';
import { webExtensions } from '../../app/extensions.js';
import { afterAuthUrl } from './after-auth.js';

const LABELS: Record<SocialProvider, string> = { github: 'GitHub', google: 'Google' };

/** One button per sign-in provider the server has configured; nothing otherwise. */
export function OAuthButtons({
  invite,
  onError,
}: {
  /** An invite to accept once signed in (plan 21.5). */
  invite?: string;
  onError(error: unknown): void;
}) {
  const { data } = useQuery(capabilitiesQuery);
  const providers = (Object.keys(LABELS) as SocialProvider[]).filter((p) => data?.oauth[p]);
  if (!providers.length) return null;

  async function start(provider: SocialProvider) {
    try {
      if (invite) await webExtensions().beforeSocialSignIn?.(invite);
      const errorCallbackURL = window.location.pathname + window.location.search;
      window.location.href = await auth.signInSocial({
        provider,
        callbackURL: afterAuthUrl(invite),
        errorCallbackURL,
      });
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button key={provider} variant="outline" onClick={() => void start(provider)}>
          {`Continue with ${LABELS[provider]}`}
        </Button>
      ))}
    </div>
  );
}
