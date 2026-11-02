import { ApiError } from '@openbots/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { EmailSignUp } from './email-sign-up.js';
import { authErrorMessage } from './messages.js';
import { OAuthButtons } from './oauth-buttons.js';

function renderButtons(oauth: { github: boolean; google: boolean }) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(capabilitiesQuery.queryKey, { oauth, deployment: 'self_hosted' });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <OAuthButtons onError={() => {}} />
    </QueryClientProvider>,
  );
}

describe('OAuth buttons', () => {
  it('shows only the providers the server has configured', () => {
    const html = renderButtons({ github: true, google: false });
    expect(html).toContain('Continue with GitHub');
    expect(html).not.toContain('Google');
  });

  it('renders nothing when no provider is configured', () => {
    expect(renderButtons({ github: false, google: false })).toBe('');
  });
});

describe('email sign-up', () => {
  it('asks for the email first, and nothing else', () => {
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <EmailSignUp onSignedIn={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain('Create your account');
    expect(html).toContain('Email');
    expect(html).toContain('Send code');
    expect(html).not.toContain('Password');
    expect(html).not.toMatch(/[–—]/);
  });

  it('explains a wrong, expired or spent code', () => {
    expect(authErrorMessage(new ApiError(400, { code: 'INVALID_OTP' }))).toMatch(/wrong/);
    expect(authErrorMessage(new ApiError(400, { code: 'OTP_EXPIRED' }))).toMatch(/expired/);
    expect(authErrorMessage(new ApiError(400, { code: 'TOO_MANY_ATTEMPTS' }))).toMatch(/new code/);
  });
});

describe('auth error messages', () => {
  it('explains signup policy rejections', () => {
    expect(authErrorMessage(new ApiError(403, { code: 'INVITE_REQUIRED' }))).toMatch(
      /needs an invite/,
    );
    expect(authErrorMessage(new ApiError(403, { code: 'INVITE_INVALID' }))).toMatch(/invalid/);
    expect(authErrorMessage('INVITE_REQUIRED')).toMatch(/needs an invite/);
    expect(authErrorMessage(new ApiError(403, { code: 'ACCOUNT_DISABLED' }))).toBe(
      'This account is disabled. Ask an admin to enable it.',
    );
  });

  it('passes other server messages through', () => {
    expect(authErrorMessage(new ApiError(401, { detail: 'Invalid email or password' }))).toBe(
      'Invalid email or password',
    );
  });
});
