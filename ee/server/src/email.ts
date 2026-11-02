// Email through Resend (plan 21.5), when RESEND_API_KEY and
// OPENBOTS_EMAIL_FROM are set: invitations and sign-up codes. Without them
// an invitation is still made and the inviter copies its link. Links and
// codes in these emails are credentials: a failed send logs why, never the
// link or code, and only a development server that sends no email may log
// sign-up codes (OPENBOTS_DEV_LOG_EMAIL_LINKS).

export interface EmailOptions {
  /** RESEND_API_KEY. */
  apiKey?: string;
  /** OPENBOTS_EMAIL_FROM, such as `OpenBots <hi@example.com>`. */
  from?: string;
  /** The HTTP client; tests stand in a fake. */
  fetch?: typeof fetch;
  /**
   * OPENBOTS_DEV_LOG_EMAIL_LINKS: with no email set up, log sign-up codes so
   * a developer can enter them. Refused with NODE_ENV=production.
   */
  logLinks?: boolean;
}

/** An error's message alone: a request error could carry what was sent. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface InviteEmail {
  to: string;
  organization: string;
  inviter: string;
  role: string;
  link: string;
}

export const RESEND_URL = 'https://api.resend.com/emails';

export function emailEnabled(options: EmailOptions): boolean {
  return Boolean(options.apiKey && options.from);
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** The message; plain words, no dashes (the copy rule). */
export function inviteMessage(invite: InviteEmail) {
  const subject = `Join ${invite.organization} on OpenBots`;
  const intro = `${invite.inviter} invited you to ${invite.organization} on OpenBots as ${
    invite.role === 'member' ? 'a member' : `an ${invite.role}`
  }.`;
  const text = `${intro}\n\nAccept the invite: ${invite.link}\n\nThe link works for 7 days.\n`;
  const html = `<p>${escape(intro)}</p><p><a href="${escape(invite.link)}">Accept the invite</a></p><p>The link works for 7 days.</p>`;
  return { subject, text, html };
}

/** Sends the invite; true when Resend took it. Never throws. */
export function sendInviteEmail(
  options: EmailOptions,
  invite: InviteEmail,
  log: (error: unknown) => void = () => {},
): Promise<boolean> {
  return send(options, invite.to, inviteMessage(invite), log);
}

/** The sign-up code email: the code, and nothing that signs anyone in. */
export function verificationMessage(code: string) {
  const subject = `${code} is your OpenBots code`;
  const text = `Your OpenBots code is ${code}.\n\nEnter it to finish signing up. It works for 10 minutes.\n`;
  const html = `<p>Your OpenBots code is</p><p style="font-size:24px;letter-spacing:4px"><strong>${escape(code)}</strong></p><p>Enter it to finish signing up. It works for 10 minutes.</p>`;
  return { subject, text, html };
}

/** Sends a sign-up code; true when Resend took it. Never throws. */
export function sendVerificationCode(
  options: EmailOptions,
  { to, code }: { to: string; code: string },
  log: (error: unknown) => void = () => {},
): Promise<boolean> {
  return send(options, to, verificationMessage(code), log);
}

/** To an address that has an account, when someone starts a sign-up with it. */
export function signUpNoticeMessage() {
  const subject = 'Someone tried to sign up with your email';
  const intro =
    'Someone tried to create an OpenBots account with this email. It already has an account, so nothing changed.';
  const next = 'If this was you, sign in instead. If not, you can ignore this email.';
  return { subject, text: `${intro}\n\n${next}\n`, html: `<p>${intro}</p><p>${next}</p>` };
}

/** Sends the notice; true when Resend took it. Never throws. */
export function sendSignUpNotice(
  options: EmailOptions,
  { to }: { to: string },
  log: (error: unknown) => void = () => {},
): Promise<boolean> {
  return send(options, to, signUpNoticeMessage(), log);
}

async function send(
  options: EmailOptions,
  to: string,
  { subject, text, html }: { subject: string; text: string; html: string },
  log: (error: unknown) => void,
): Promise<boolean> {
  if (!emailEnabled(options)) return false;
  try {
    const res = await (options.fetch ?? fetch)(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: options.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    return true;
  } catch (error) {
    log(error);
    return false;
  }
}
