import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@openbots/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { activateOrganization, organizationsQuery, reloadInto } from './api.js';
import { CreateOrganizationForm } from './create-organization.js';

// The organization switcher at the top of the sidebar (plan 21.5): only for
// someone in two or more organizations. Settings > Organization has Create
// organization for everyone else.

export function OrganizationSwitcher() {
  const { data } = useQuery(organizationsQuery);
  const [creating, setCreating] = useState(false);
  const open = useMutation({ mutationFn: activateOrganization, onSuccess: () => reloadInto('/') });
  const items = data?.items ?? [];
  if (items.length < 2) return null;
  const active = items.find((o) => o.active);

  return (
    <div className="px-3 pt-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="w-full justify-between" aria-label="Organization">
            <span className="truncate">{active?.name ?? 'Organization'}</span>
            <span aria-hidden className="text-muted-foreground">
              ⌄
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {items.map((org) => (
            <DropdownMenuItem
              key={org.id}
              disabled={org.active || org.suspended || open.isPending}
              onSelect={() => open.mutate(org.id)}
            >
              <span className="truncate">{org.name}</span>
              {org.suspended && (
                <span className="ml-auto text-xs text-muted-foreground">Suspended</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            Create organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
          </DialogHeader>
          <CreateOrganizationForm />
        </DialogContent>
      </Dialog>
    </div>
  );
}
