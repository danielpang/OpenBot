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
});
