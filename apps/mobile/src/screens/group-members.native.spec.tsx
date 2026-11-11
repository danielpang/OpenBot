import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { GroupMembers } from './group-members';
import type { Bot, Chat } from './data';

let mockLimit = 6;
jest.mock('@openbots/api-client', () => ({ unwrap: jest.fn() }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
jest.mock('../api/provider', () => ({ useApi: () => ({}) }));
jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('./data', () => ({ useGroupLimit: () => mockLimit }));

const bots = ['a', 'b', 'c', 'd'].map(
  (id) => ({ id, name: `Bot ${id}`, handle: id, hidden: false }) as unknown as Bot,
);
const group = (botIds: string[]) => ({ id: 'group', type: 'group', botIds }) as unknown as Chat;
const show = (botIds: string[]) =>
  render(<GroupMembers chat={group(botIds)} bots={bots} visible onClose={() => {}} />);

beforeEach(() => {
  mockLimit = 6;
});

describe('group members and the server limit', () => {
  it('offers more Bots while the group is below the limit', () => {
    mockLimit = 4;
    show(['a', 'b', 'c']);
    expect(screen.getByText(/A group keeps 2 to 4 Bots/)).toBeTruthy();
    expect(screen.getByText('Add a Bot')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' }).props.accessibilityState.disabled).toBe(
      false,
    );
  });

  it('stops offering Bots once the group is at the limit', () => {
    mockLimit = 3;
    show(['a', 'b', 'c']);
    expect(screen.getByText(/A group keeps 2 to 3 Bots/)).toBeTruthy();
    expect(screen.queryByText('Add a Bot')).toBeNull();
  });
});
