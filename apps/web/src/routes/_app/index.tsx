import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { botsQuery, rosterSections } from '../../features/bots/queries.js';
import { Office } from '../../features/office/office.js';

export const Route = createFileRoute('/_app/')({
  component: Home,
});

/**
 * Home: the user's Bots at work in the office, in the order the sidebar lists
 * them. View > Show Office Space (Cmd+Shift+O) comes back here from any page.
 */
function Home() {
  const { data } = useQuery(botsQuery);
  if (!data) return null;
  const { pinned, bots } = rosterSections(data.items);
  const team = [...pinned, ...bots];
  return (
    <div className="h-full">
      <Office
        bots={team}
        caption={
          team.length === 0
            ? 'Your Bots will live here.'
            : `${team.length === 1 ? 'Your Bot is' : `Your ${team.length} Bots are`} in the office. Click one to open its chat.`
        }
      />
    </div>
  );
}
