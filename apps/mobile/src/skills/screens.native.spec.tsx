import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SkillEditorScreen, SkillImportScreen, SkillsScreen } from './screens';
import { BotSkills } from './bot-skills';

type Call = (...args: unknown[]) => Promise<unknown>;
const mockGet = jest.fn<Call>();
const mockPost = jest.fn<Call>();
const mockPatch = jest.fn<Call>();
const mockPut = jest.fn<Call>();
const mockDelete = jest.fn<Call>();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockPick = jest.fn<Call>();
const mockParams: { id?: string } = {};
let mockFileText = '';
jest.mock('../api/provider', () => ({
  useApi: () => ({
    GET: mockGet,
    POST: mockPost,
    PATCH: mockPatch,
    PUT: mockPut,
    DELETE: mockDelete,
  }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
    back: () => mockBack(),
  },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockPick(...args),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    size = 10;
    text = async () => mockFileText;
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const ok = (data: unknown) => ({ data, response: { ok: true } });
const skill = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Weekly report',
  slug: 'weekly-report',
  summary: 'Write the weekly report',
  content: 'Write the weekly report',
  source: 'manual',
  createdFromRunId: null,
  origin: null,
  usedBy: [{ id: 'bot-1', name: 'Ada', handle: 'ada' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
let enabled: string[];
const caches: QueryClient[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  delete mockParams.id;
  enabled = [];
  mockGet.mockImplementation(async (path) =>
    ok(path === '/api/v1/skills' ? { items: [skill] } : { skillIds: enabled }),
  );
});
afterEach(() => {
  cleanup();
  caches.forEach((cache) => cache.clear());
  caches.length = 0;
});
function show(node: React.ReactElement) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  caches.push(cache);
  render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>);
}

describe('Skills library', () => {
  it('lists Skills with the Bots that use them and opens one', async () => {
    show(<SkillsScreen />);
    const open = await screen.findByRole('button', { name: 'Open Weekly report' });
    expect(screen.getByText('Used by Ada')).toBeTruthy();
    fireEvent.press(open);
    expect(mockPush).toHaveBeenCalledWith(`/skills/${skill.id}`);
    fireEvent.press(screen.getByRole('button', { name: 'Import from GitHub' }));
    expect(mockPush).toHaveBeenCalledWith('/skills/import');
  });
});

describe('Skill editor', () => {
  it('creates a Skill filled from a markdown file', async () => {
    mockFileText = '---\nname: Release notes\ndescription: Use for releases\n---\nList changes.';
    mockPick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/SKILL.md', name: 'SKILL.md' }],
    });
    mockPost.mockResolvedValue(ok({ ...skill, id: 'new-id' }));
    show(<SkillEditorScreen isNew />);
    await act(async () =>
      fireEvent.press(screen.getByRole('button', { name: 'Fill from a file' })),
    );
    expect(screen.getByLabelText('Name').props.value).toBe('Release notes');
    expect(screen.getByLabelText('Content').props.value).toBe('Use for releases\n\nList changes.');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Create' })));
    expect(mockPost).toHaveBeenCalledWith('/api/v1/skills', {
      body: { name: 'Release notes', content: 'Use for releases\n\nList changes.' },
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/skills/new-id'));
  });

  it('saves edits to an existing Skill', async () => {
    mockParams.id = skill.id;
    mockPatch.mockResolvedValue(ok(skill));
    show(<SkillEditorScreen />);
    const name = await screen.findByLabelText('Name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.changeText(name, '  Monthly report ');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Save' })));
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/skills/{id}', {
      params: { path: { id: skill.id } },
      body: { name: 'Monthly report', content: skill.content },
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });
});

describe('Import from GitHub', () => {
  it('previews a link, then imports the picked Skills', async () => {
    const preview = {
      source: {
        url: 'https://github.com/o/r',
        repo: 'o/r',
        ref: 'main',
        sha: 'a'.repeat(40),
        path: '',
      },
      skills: [
        { path: 'a/SKILL.md', name: 'a', suggestedName: 'a', description: 'First', error: null },
        { path: 'b/SKILL.md', name: 'b', suggestedName: 'b', description: '', error: null },
      ],
      more: false,
      authenticated: false,
      room: 10,
      limit: 50,
    };
    mockPost.mockImplementation(async (path) =>
      path === '/api/v1/skills/import/preview'
        ? ok(preview)
        : ok({ items: [{ skill, path: 'a/SKILL.md' }] }),
    );
    show(<SkillImportScreen />);
    fireEvent.changeText(screen.getByLabelText('GitHub link'), ' https://github.com/o/r ');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Find Skills' })));
    expect(mockPost).toHaveBeenCalledWith('/api/v1/skills/import/preview', {
      body: { url: 'https://github.com/o/r' },
    });
    await screen.findByText(/Found 2 Skills in o\/r at main/);
    fireEvent(screen.getByLabelText('Import b/SKILL.md'), 'valueChange', false);
    fireEvent.changeText(screen.getByLabelText('Name for a/SKILL.md'), 'Alpha');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Import 1 Skill' })));
    expect(mockPost).toHaveBeenLastCalledWith('/api/v1/skills/import', {
      body: {
        url: 'https://github.com/o/r',
        ref: 'main',
        sha: 'a'.repeat(40),
        skills: [{ path: 'a/SKILL.md', name: 'Alpha' }],
      },
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/skills/${skill.id}`));
  });
});

describe('Bot Skills', () => {
  it('enables a Skill for the Bot', async () => {
    mockPut.mockResolvedValue(ok({ skillIds: [skill.id] }));
    show(<BotSkills botId="bot-1" />);
    const toggle = await screen.findByLabelText('Enable Weekly report');
    expect(toggle.props.value).toBe(false);
    await act(async () => fireEvent(toggle, 'valueChange', true));
    expect(mockPut).toHaveBeenCalledWith('/api/v1/bots/{id}/skills', {
      params: { path: { id: 'bot-1' } },
      body: { skillIds: [skill.id] },
    });
  });
});
