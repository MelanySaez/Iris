// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api';
import type { AssistantUiContext } from '../../assistant';
import { AssistantWidget } from './AssistantWidget';

const context: AssistantUiContext = { workspace: 'sky', channel: 44, color_mode: 'single' };

function setup(onAction = vi.fn(() => ({ ok: true }))) {
  render(<AssistantWidget getContext={() => context} onAction={onAction} />);
  return { onAction };
}

async function openPanel() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));
  });
}

async function send(text: string) {
  const box = screen.getByRole('textbox', { name: 'Message the assistant' });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' });
  });
}

describe('AssistantWidget', () => {
  beforeEach(() => {
    vi.spyOn(api, 'assistantStatus').mockResolvedValue({ enabled: true, model: 'test-model' });
    vi.spyOn(api, 'reportAssistantOutcome').mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens and closes from the launcher in the corner', async () => {
    setup();
    expect(screen.queryByRole('dialog', { name: 'Planet X assistant' })).toBeNull();
    await openPanel();
    expect(screen.getByRole('dialog', { name: 'Planet X assistant' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }));
    expect(screen.queryByRole('dialog', { name: 'Planet X assistant' })).toBeNull();
  });

  it('sends the question with the UI context and runs the returned actions', async () => {
    const chat = vi.spyOn(api, 'assistantChat').mockResolvedValue({
      conversation_id: 'c',
      request_id: 'r1',
      reply: 'Opening Records.',
      actions: [{ type: 'navigate', workspace: 'records' }],
      cached: true,
      cache_kind: 'exact',
    });
    const { onAction } = setup();
    await openPanel();
    await send('  Open Records ');

    const body = chat.mock.calls[0][0];
    expect(body.messages).toEqual([{ role: 'user', content: 'Open Records' }]);
    expect(body.context).toEqual(context);
    expect(body.conversation_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText('Opening Records.')).toBeTruthy();
    expect(onAction).toHaveBeenCalledWith({ type: 'navigate', workspace: 'records' });
    expect(screen.getByRole('listitem').textContent).toBe('Open Records');
    expect(screen.getByText('From cache')).toBeTruthy();
    expect(api.reportAssistantOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'r1', status: 'executed', action: { type: 'navigate', workspace: 'records' } }),
    );

    // The next turn carries the history.
    chat.mockResolvedValueOnce({
      conversation_id: 'c', request_id: 'r2', reply: 'Done.', actions: [], cached: false, cache_kind: null,
    });
    await send('thanks');
    expect(chat.mock.calls[1][0].messages).toEqual([
      { role: 'user', content: 'Open Records' },
      { role: 'assistant', content: 'Opening Records.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('clips very long replies before sending them back as history', async () => {
    const chat = vi.spyOn(api, 'assistantChat').mockResolvedValueOnce({
      conversation_id: 'c', request_id: 'r1', reply: 'y'.repeat(25000), actions: [], cached: false, cache_kind: null,
    });
    setup();
    await openPanel();
    await send('explain everything');
    chat.mockResolvedValueOnce({
      conversation_id: 'c', request_id: 'r2', reply: 'ok', actions: [], cached: false, cache_kind: null,
    });
    await send('thanks');

    const history = chat.mock.calls[1][0].messages;
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toHaveLength(20000);
  });

  it('refuses an action outside the allowlist without running it', async () => {
    vi.spyOn(api, 'assistantChat').mockResolvedValue({
      conversation_id: 'c',
      request_id: 'r1',
      reply: 'Done.',
      actions: [{ type: 'delete_selection', id: 'x' } as never],
      cached: false,
      cache_kind: null,
    });
    const { onAction } = setup();
    await openPanel();
    await send('do it');

    await screen.findByText('Done.');
    expect(onAction).not.toHaveBeenCalled();
    expect(api.reportAssistantOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });

  it('explains when the assistant is disabled on the server', async () => {
    vi.mocked(api.assistantStatus).mockResolvedValue({ enabled: false, model: 'test-model' });
    setup();
    await openPanel();
    expect(await screen.findByText(/set ASSISTANT_API_KEY and ASSISTANT_MODEL/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('shows request errors and keeps the unsent text', async () => {
    vi.spyOn(api, 'assistantChat').mockRejectedValue(
      new ApiError('Too many requests', 429, 'Too many assistant requests; wait a minute.'),
    );
    setup();
    await openPanel();
    await send('hello');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('wait a minute');
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).value).toBe('hello');
  });

  it('lists the logged activity of the conversation', async () => {
    const logs = vi.spyOn(api, 'assistantLogs').mockResolvedValue({
      items: [
        { ts: '2026-11-14T20:00:01Z', event: 'model_call', model: 'test-model', input_tokens: 900, output_tokens: 40, latency_ms: 1200, stop_reason: 'end_turn' },
        { ts: '2026-11-14T20:00:00Z', event: 'cache_hit', kind: 'similar' },
      ],
    });
    setup();
    await openPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    await waitFor(() => expect(logs).toHaveBeenCalled());
    expect(logs.mock.calls[0][0]?.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/test-model · 900 in \/ 40 out · 1200 ms/)).toBeTruthy();
    expect(screen.getByText(/similar/)).toBeTruthy();
  });
});
