import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SidebarSection } from '../../app/sidebar.js';
import type { Bot } from '../bots/queries.js';
import { chatsQuery, groupsOf, groupTitle } from './api.js';

// The sidebar's Groups section (PRD section 5): one row per group chat, most
// recently active first, named by its title or its Bots.

export function GroupsSection({ bots }: { bots: readonly Bot[] }) {
  const { data } = useQuery(chatsQuery);
  const groups = groupsOf(data?.items);
  return (
    <SidebarSection title="Groups" empty="No groups yet.">
      {groups.length ? (
        <ul className="flex flex-col gap-0.5">
          {groups.map((chat) => (
            <li key={chat.id}>
              <Link
                to="/groups/$chatId"
                params={{ chatId: chat.id }}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
                activeProps={{ className: 'bg-accent' }}
              >
                <span aria-hidden className="w-6 text-center text-muted-foreground">
                  #
                </span>
                <span className="truncate">{groupTitle(chat, bots)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : undefined}
    </SidebarSection>
  );
}
