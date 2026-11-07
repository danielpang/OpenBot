import { createFileRoute } from '@tanstack/react-router';
import { Page } from '../../app/page.js';
import { Attachments } from '../../features/attachments/attachments.js';
import type { PtyAttach } from '../../features/computer/api.js';
import { ComputerPage } from '../../features/computer/computer-page.js';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/_app/computer')({
  // Open terminal on a coding session links here with where to attach (CA7, I15).
  validateSearch: (search: Record<string, unknown>): PtyAttach => {
    const cwd = text(search.cwd);
    const user = text(search.user);
    const preset = text(search.preset);
    return {
      ...(cwd ? { cwd } : {}),
      ...(user ? { user } : {}),
      ...(preset ? { preset } : {}),
    };
  },
  component: Computer,
});

function Computer() {
  const attach = Route.useSearch();
  return (
    <Page title="Computer">
      <ComputerPage attach={attach.cwd ? attach : undefined} />
      <Attachments />
    </Page>
  );
}
