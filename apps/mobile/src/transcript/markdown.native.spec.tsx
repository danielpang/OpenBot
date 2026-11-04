import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import Markdown from 'react-native-markdown-display';

describe('native Markdown parser compatibility', () => {
  it('renders headings, lists, code and links with the patched parser', () => {
    const openLink = jest.fn(() => false);
    render(
      <Markdown onLinkPress={openLink}>
        {
          '# Result\n\n- First item\n- Second item\n\n```ts\nconst ready = true;\n```\n\n[Open report](https://example.com/report)'
        }
      </Markdown>,
    );
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('First item')).toBeTruthy();
    expect(screen.getByText('Second item')).toBeTruthy();
    expect(screen.getByText('const ready = true;')).toBeTruthy();
    fireEvent.press(screen.getByText('Open report'));
    expect(openLink).toHaveBeenCalledWith('https://example.com/report');
  });

  it('keeps executable URL schemes inert', () => {
    const openLink = jest.fn(() => false);
    render(<Markdown onLinkPress={openLink}>{'[Unsafe](javascript:alert%281%29)'}</Markdown>);
    expect(screen.getByText('[Unsafe](javascript:alert%281%29)')).toBeTruthy();
    expect(openLink).not.toHaveBeenCalled();
  });
});
