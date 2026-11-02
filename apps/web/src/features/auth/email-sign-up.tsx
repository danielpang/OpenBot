import { Button } from '@openbots/ui';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { auth } from '../../app/api.js';
import { AuthCard, AuthForm, Field } from './auth-form.js';
import { authErrorMessage } from './messages.js';

// Managed sign-up (plan 21.6): the email first, then the 6-digit code sent
// to it, then the name and password. Whoever holds the inbox sets the
// password. The server keeps the request in an HttpOnly cookie.

export type SignUpStep = 'email' | 'code' | 'account';

export function EmailSignUp({
  invite,
  error: outsideError,
  footer,
  onSignedIn,
}: {
  invite?: string;
  /** An error from outside the form, such as a GitHub sign-in that failed. */
  error?: unknown;
  /** Under the first step: other ways in. */
  footer?: ReactNode;
  onSignedIn(): unknown;
}) {
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<SignUpStep>('email');
  const start = useMutation({
    mutationFn: auth.startSignUp,
    onSuccess: () => setStep('code'),
  });
  const confirm = useMutation({
    mutationFn: auth.confirmSignUp,
    onSuccess: () => setStep('account'),
  });
  const complete = useMutation({ mutationFn: auth.completeSignUp, onSuccess: onSignedIn });
  const send = (address: string) => {
    setEmail(address);
    confirm.reset();
    start.mutate({ email: address, ...(invite ? { invite } : {}) });
  };

  if (step === 'code') {
    const error = confirm.error ?? start.error;
    return (
      <AuthCard title="Enter the code">
        <p className="text-center text-sm text-muted-foreground">
          We sent a 6-digit code to {email}.
        </p>
        <AuthForm
          submitLabel="Confirm"
          pending={confirm.isPending}
          error={error ? authErrorMessage(error) : null}
          onSubmit={(form) => confirm.mutate({ code: String(form.get('code')).trim() })}
        >
          <Field
            label="Code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
          />
        </AuthForm>
        <Button variant="ghost" disabled={start.isPending} onClick={() => send(email)}>
          Send a new code
        </Button>
      </AuthCard>
    );
  }

  if (step === 'account') {
    return (
      <AuthCard title="Finish signing up">
        <AuthForm
          submitLabel="Create account"
          pending={complete.isPending}
          error={complete.error ? authErrorMessage(complete.error) : null}
          onSubmit={(form) =>
            complete.mutate({
              name: String(form.get('name')),
              password: String(form.get('password')),
            })
          }
        >
          <Field label="Your name" name="name" autoComplete="name" required autoFocus />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </AuthForm>
      </AuthCard>
    );
  }

  const error = start.error ?? outsideError;
  return (
    <AuthCard title="Create your account">
      <AuthForm
        submitLabel="Send code"
        pending={start.isPending}
        error={error ? authErrorMessage(error) : null}
        onSubmit={(form) => send(String(form.get('email')).trim())}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required />
      </AuthForm>
      {footer}
    </AuthCard>
  );
}
