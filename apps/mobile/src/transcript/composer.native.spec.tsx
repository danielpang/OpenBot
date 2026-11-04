import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ActionSheetIOS, Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Composer } from './composer';
const mockUpload = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../api/provider', () => ({ useMobile: () => ({ uploadAttachment: mockUpload }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
beforeEach(() => {
  jest.clearAllMocks();
  mockUpload.mockReset();
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
describe('native composer', () => {
  it('keeps an accessible Send action without a visible text label', () => {
    render(<Composer onSend={async () => {}} sending={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.queryByText('Send')).toBeNull();
  });

  it('offers photos, files and mentions from the compact add button', () => {
    render(<Composer onSend={async () => {}} sending={false} />);
    fireEvent.press(screen.getByRole('button', { name: 'Add to message' }));
    expect(screen.getByRole('button', { name: 'Photos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mention a Bot' })).toBeTruthy();
    expect(ActionSheetIOS.showActionSheetWithOptions).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Close attachment options' }));
    expect(screen.queryByRole('button', { name: 'Photos' })).toBeNull();
  });

  it('inserts a mention through the add menu', () => {
    render(<Composer onSend={async () => {}} sending={false} />);
    fireEvent.changeText(screen.getByLabelText('Message'), 'Hello');
    fireEvent.press(screen.getByRole('button', { name: 'Add to message' }));
    fireEvent.press(screen.getByRole('button', { name: 'Mention a Bot' }));
    expect(screen.getByLabelText('Message').props.value).toBe('Hello @');
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
  });

  it('sends a file-only message selected from the add menu', async () => {
    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///notes.txt', name: 'notes.txt', mimeType: 'text/plain', lastModified: 0 },
      ],
    });
    mockUpload.mockResolvedValue({ id: 'file-1' });
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
    render(<Composer onSend={send} sending={false} />);
    fireEvent.press(screen.getByRole('button', { name: 'Add to message' }));
    fireEvent.press(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy(),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ attachments: ['file-1'] }));
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
  });

  it('disables editing and actions while sending', () => {
    render(<Composer onSend={async () => {}} sending />);
    expect(screen.getByLabelText('Message').props.editable).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Sending message' }).props.accessibilityState,
    ).toEqual({ disabled: true, busy: true });
    expect(
      screen.getByRole('button', { name: 'Add to message' }).props.accessibilityState.disabled,
    ).toBe(true);
  });
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
