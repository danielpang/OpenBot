import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { MessagePartView } from './parts';
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
