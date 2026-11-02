import { createFileRoute, redirect } from '@tanstack/react-router';
import type { ToolsSearch } from '../../features/tools/tools-page.js';

// The Connectors page lived at /tools until it was renamed; old links, and
// events stored with a `/tools?connector=<id>` link, land on it with their
// search intact.
export const Route = createFileRoute('/_app/tools')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/connectors', search: search as ToolsSearch, replace: true });
  },
});
