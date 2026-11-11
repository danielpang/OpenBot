import React, { useState } from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MessageReactions, REACTION_EMOJI } from './reactions';
import type { Message } from './model';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const reaction = (emoji: string, reactorType: 'user' | 'bot') =>
  ({ emoji, reactorType, reactorId: reactorType }) as NonNullable<Message['reactions']>[number];

function Footer({
  reactions = [],
  onReaction,
}: {
  reactions?: Message['reactions'];
  onReaction: (emoji: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <MessageReactions
      message={{ reactions, replyCount: 0 }}
      alignEnd={false}
      picking={picking}
      onPicking={setPicking}
      onReaction={onReaction}
    />
  );
}

describe('reacting to a message', () => {
  it('offers thumbs up and down, a heart, 100 and OK', () => {
    expect(REACTION_EMOJI).toEqual(['👍', '👎', '❤️', '💯', '👌']);
  });

  it('opens the choices in the message, sends the one tapped, and closes', () => {
    const onReaction = jest.fn();
    render(<Footer onReaction={onReaction} />);
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Add a reaction' }));
    for (const emoji of REACTION_EMOJI)
      expect(screen.getByRole('button', { name: `React with ${emoji}` })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'React with 💯' }));
    expect(onReaction).toHaveBeenCalledWith('💯');
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
  });

  it('closes the choices without reacting', () => {
    const onReaction = jest.fn();
    render(<Footer onReaction={onReaction} />);
    const toggle = screen.getByRole('button', { name: 'Add a reaction' });
    fireEvent.press(toggle);
    fireEvent.press(toggle);
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    expect(onReaction).not.toHaveBeenCalled();
  });

  it('counts reactions and marks the ones that are yours', () => {
    const onReaction = jest.fn();
    render(
      <Footer
        onReaction={onReaction}
        reactions={[reaction('👍', 'user'), reaction('👍', 'bot'), reaction('👎', 'bot')]}
      />,
    );
    const mine = screen.getByRole('button', { name: 'Remove 👍, 2 reactions' });
    expect(mine.props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('button', { name: 'React 👎, 1 reaction' })).toBeTruthy();
    fireEvent.press(mine);
    expect(onReaction).toHaveBeenCalledWith('👍');
    fireEvent.press(screen.getByRole('button', { name: 'Add a reaction' }));
    expect(screen.getByRole('button', { name: 'Remove 👍' })).toBeTruthy();
  });
});
