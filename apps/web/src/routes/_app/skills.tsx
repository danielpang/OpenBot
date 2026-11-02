import { createFileRoute } from '@tanstack/react-router';
import { Page } from '../../app/page.js';
import { SkillsPage } from '../../features/skills/skills-page.js';

export const Route = createFileRoute('/_app/skills')({
  component: () => (
    <Page title="Skills">
      <SkillsPage />
    </Page>
  ),
});
