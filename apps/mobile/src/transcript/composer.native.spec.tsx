import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Composer } from './composer';
const mockUpload = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../api/provider', () => ({ useMobile: () => ({ uploadAttachment: mockUpload }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
beforeEach(() => {
  mockUpload.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
describe('native composer', () => {
  it('keeps the draft if sending fails so the user can retry', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(new Error('Offline'));
    render(<Composer onSend={send} sending={false} />);
    fireEvent.changeText(screen.getByLabelText('Message'), 'Keep this draft');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Message not sent', 'Offline'));
    expect(screen.getByLabelText('Message').props.value).toBe('Keep this draft');
  });
  it('sends a trimmed thread reply and clears it only after success', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
    render(<Composer onSend={send} sending={false} threadRootId="root-1" />);
    fireEvent.changeText(screen.getByLabelText('Message'), '  A reply  ');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ text: 'A reply', threadRootId: 'root-1' }),
    );
    await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe(''));
  });
  it('disables the send button for an empty draft', () => {
    render(
      <Composer onSend={jest.fn<(...args: unknown[]) => Promise<unknown>>()} sending={false} />,
    );
    expect(screen.getByRole('button', { name: 'Send' }).props.accessibilityState.disabled).toBe(
      true,
    );
  });
});
