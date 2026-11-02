import { createFileRoute } from '@tanstack/react-router';
import { Page } from '../../app/page.js';
import { Attachments } from '../../features/attachments/attachments.js';
import { ComputerPage } from '../../features/computer/computer-page.js';

export const Route = createFileRoute('/_app/computer')({
  component: () => (
    <Page title="Computer">
      <ComputerPage />
      <Attachments />
    </Page>
  ),
});
