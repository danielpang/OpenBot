import { createFileRoute, useRouter } from '@tanstack/react-router';
import { CodingAgentsSettings } from '../../../features/coders/settings.js';

export const Route = createFileRoute('/_app/settings/coding-agents')({
  component: CodingAgentsRoute,
});

function CodingAgentsRoute() {
  const router = useRouter();
  return <CodingAgentsSettings onNavigate={(href) => void router.navigate({ href })} />;
}
