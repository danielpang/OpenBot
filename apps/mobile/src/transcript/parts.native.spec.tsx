import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ActivityView, MessagePartView } from './parts';
import type { ActivityStep } from './blocks';
import type { Message } from './model';

jest.mock('../api/provider', () => ({ useMobile: () => ({}) }));
jest.mock('../api/use-file-source', () => ({ useFileSource: () => undefined }));
jest.mock('./widget', () => ({ NativeWidget: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

describe('message text parts', () => {
  it('lets list items size to their text so they stay inside a message bubble', () => {
    const part = { type: 'text', text: '1. Define our ICP\n2. What are we selling them?' } as const;
    render(
      <MessagePartView
        part={part as Message['parts'][number]}
        message={{ id: 'm1', authorType: 'user', parts: [part] } as unknown as Message}
        index={0}
      />,
    );
    // The item's text sits in a Text inside a paragraph View inside the list content View.
    let node = screen.getByText('Define our ICP').parent;
    while (node && StyleSheet.flatten(node.props.style)?.flexGrow === undefined) node = node.parent;
    const style = StyleSheet.flatten(node?.props.style);
    expect(style).toMatchObject({ flex: 0, flexGrow: 1, flexShrink: 1 });
  });

  it("keeps a message's text mounted when the server sends an identical copy", () => {
    const text = 'Here is the **plan**:\n\n- First step\n- Second step';
    const copy = () => {
      const part = { type: 'text', text } as Message['parts'][number];
      return {
        part,
        message: { id: 'm1', authorType: 'bot', parts: [part] } as unknown as Message,
      };
    };
    const first = copy();
    const view = render(<MessagePartView part={first.part} message={first.message} index={0} />);
    const before = screen.getByText('First step');
    // The same message re-read from the server: equal content in new objects.
    const second = copy();
    view.rerender(<MessagePartView part={second.part} message={second.message} index={0} />);
    // Remounting the text would flicker and re-measure the row on every refresh.
    expect(screen.getByText('First step')).toBe(before);
  });
});

describe('tool activity in a message', () => {
  const step = (id: string, label: string, done = true): ActivityStep => ({
    id,
    label,
    done,
    error: false,
    args: { url: `https://${id}.com` },
    result: done ? { ok: id } : undefined,
  });

  it('folds many steps into one line until it is opened', () => {
    const steps = [step('a', 'Read a.com'), step('b', 'Read b.com'), step('c', 'Read c.com')];
    render(<ActivityView steps={steps} />);
    expect(screen.getByText('Read c.com · 3 steps')).toBeTruthy();
    expect(screen.queryByText('Read a.com')).toBeNull();
    expect(screen.queryByText('Read b.com')).toBeNull();
    fireEvent.press(screen.getByLabelText('Read c.com, 3 steps'));
    expect(screen.getByText('Read a.com')).toBeTruthy();
    expect(screen.getByText('Read b.com')).toBeTruthy();
    // Each step still opens to what the tool returned.
    fireEvent.press(screen.getByText('Read a.com'));
    expect(screen.getByText(/"ok": "a"/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Read c.com, 3 steps'));
    expect(screen.queryByText('Read a.com')).toBeNull();
  });

  it('shows the step in progress while the Bot is still working', () => {
    render(<ActivityView steps={[step('a', 'Read a.com'), step('b', 'Reading b.com', false)]} />);
    expect(screen.getByText('Reading b.com… · 2 steps')).toBeTruthy();
  });

  it('shows a single step as its own row', () => {
    render(<ActivityView steps={[step('a', 'Read a.com')]} />);
    expect(screen.getByText('Read a.com')).toBeTruthy();
    expect(screen.queryByTestId('message-activity')).toBeNull();
  });
});
