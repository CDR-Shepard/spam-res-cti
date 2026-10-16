import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AGENT_PROMPT_MAX_CHARS } from '@cti/contracts';
import { renderWithRouter } from '../test/render';
import { respond, stubApi, type StubCall } from '../test/stub-api';
import {
  DEFAULT_INBOUND,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_VOICEMAIL,
  SAVED_AT,
  VERSION_A,
  VERSION_B,
  promptState,
  promptsResponse,
  version,
} from '../test/agent-prompt-fixtures';
import { formatDateTime } from '../lib/outreach-words';
import { AgentPromptPage } from './agent-prompt-page';

const LIST = 'GET /api/settings/agent-prompts';
const PUT_INSTRUCTIONS = 'PUT /api/settings/agent-prompts/instructions';
const PUT_VOICEMAIL = 'PUT /api/settings/agent-prompts/voicemail';
const PUT_INBOUND = 'PUT /api/settings/agent-prompts/inbound';
const PREVIEW_INSTRUCTIONS = 'POST /api/settings/agent-prompts/instructions/preview';
const SAVED_WORDS = 'Saved — the next call uses it.';
const REPLACES_WORDS = "A saved version replaces the built-in prompt — later improvements to it won't reach your calls until you reset or copy them in.";

afterEach(() => vi.unstubAllGlobals());

const instructionsBox = () => screen.findByRole('textbox', { name: 'Call instructions' });
const sent = (calls: StubCall[], route: string) => calls.filter((c) => `${c.method} ${c.url}` === route);

/** `routes` is the live stub table: a test may change an answer after the page is up. The prompts list defaults to nothing saved. */
async function render(routes: Record<string, unknown> = {}) {
  if (!(LIST in routes)) routes[LIST] = promptsResponse();
  const calls = stubApi(routes);
  const view = renderWithRouter(<AgentPromptPage />, { isAdmin: true });
  const box = await instructionsBox();
  return { calls, box, ...view };
}

describe('AgentPromptPage', () => {
  it('shows a non-admin who is not allowed, and asks for nothing', async () => {
    const calls = stubApi({});
    renderWithRouter(<AgentPromptPage />);
    expect(await screen.findByText('Only admins can edit the agent prompt.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('opens on the call instructions with the built-in default and says it is the default in use', async () => {
    const { box } = await render();
    expect(screen.getByRole('heading', { name: 'Agent prompt' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Call instructions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Voicemail message' })).toHaveAttribute('aria-selected', 'false');
    expect(box).toHaveValue(DEFAULT_INSTRUCTIONS);
    expect(box).toHaveClass('font-mono');
    expect(screen.getByText('Using the default')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says a saved version replaces the built-in prompt: by the status line once a version is saved, and by Save always', async () => {
    const { box } = await render();
    // Default in use: the warning belongs to Save (the first save is what freezes the prompt), once.
    expect(screen.getAllByText(REPLACES_WORDS)).toHaveLength(1);
    expect(box).toBeInTheDocument();
  });

  it('with a saved version active, says it by the status line as well as by Save, on both tabs', async () => {
    const user = userEvent.setup();
    await render({
      [LIST]: promptsResponse({
        instructions: promptState('instructions', { active: 'My prompt for {{agent_name}}.', updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com' }),
        voicemail: promptState('voicemail', { active: 'Hi {{first_name}}.', updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com' }),
      }),
    });
    const status = screen.getByText(`Edited ${formatDateTime(SAVED_AT)} by grant@gghomes.com`);
    const notes = screen.getAllByText(REPLACES_WORDS);
    expect(notes).toHaveLength(2);
    // The first is under the status line, above the editor; the second is below the editor, by the buttons.
    const textbox = screen.getByRole('textbox', { name: 'Call instructions' });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(status, notes[0] as HTMLElement)).toBe(true);
    expect(follows(notes[0] as HTMLElement, textbox)).toBe(true);
    expect(follows(textbox, notes[1] as HTMLElement)).toBe(true);
    expect(follows(notes[1] as HTMLElement, screen.getByRole('button', { name: 'Save' }))).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
    expect(await screen.findAllByText(REPLACES_WORDS)).toHaveLength(2);
  });

  it('a reset to the default takes the status-line note away again, keeping the one by Save', async () => {
    const user = userEvent.setup();
    await render({
      [LIST]: promptsResponse({ instructions: promptState('instructions', { active: 'My own prompt.', updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com', versions: [version()] }) }),
      [PUT_INSTRUCTIONS]: promptState('instructions', { active: null, updatedAt: SAVED_AT, versions: [version({ id: VERSION_B, isDefault: true, chars: 0 }), version()] }),
    });
    expect(screen.getAllByText(REPLACES_WORDS)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset to default' }));
    expect(await screen.findByText('Using the default')).toBeInTheDocument();
    expect(screen.getAllByText(REPLACES_WORDS)).toHaveLength(1);
  });

  it('shows the saved prompt, and who edited it and when', async () => {
    const saved = 'You are {{agent_name}}. Be brief.';
    await render({ [LIST]: promptsResponse({ instructions: promptState('instructions', { active: saved, updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com' }) }) });
    expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(saved);
    expect(screen.getByText(`Edited ${formatDateTime(SAVED_AT)} by grant@gghomes.com`)).toBeInTheDocument();
    expect(screen.queryByText('Using the default')).not.toBeInTheDocument();
  });

  it('an edit turns Save on; saving sends the text, shows the confirmation, and turns Save off again', async () => {
    const user = userEvent.setup();
    const typed = `${DEFAULT_INSTRUCTIONS} Keep it short.`;
    const { calls, box } = await render({
      [PUT_INSTRUCTIONS]: promptState('instructions', { active: typed, updatedAt: SAVED_AT, updatedByEmail: 'admin@gg.co', versions: [version({ createdByEmail: 'admin@gg.co' })] }),
    });
    await user.type(box, ' Keep it short.');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await screen.findByText(SAVED_WORDS)).toBeInTheDocument();
    expect(sent(calls, PUT_INSTRUCTIONS).map((c) => c.body)).toEqual([{ template: typed }]);
    expect(screen.getByText(`Edited ${formatDateTime(SAVED_AT)} by admin@gg.co`)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(typed);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // The new version is in the list, without asking the list again.
    expect(sent(calls, LIST)).toHaveLength(1);
    expect(screen.getByRole('button', { name: `Load the version saved ${formatDateTime(SAVED_AT)}` })).toBeInTheDocument();
  });

  it('editing again after a save clears the confirmation', async () => {
    const user = userEvent.setup();
    const { box } = await render({ [PUT_INSTRUCTIONS]: promptState('instructions', { active: `${DEFAULT_INSTRUCTIONS} a`, updatedAt: SAVED_AT }) });
    await user.type(box, ' a');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(SAVED_WORDS)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Call instructions' }), 'b');
    expect(screen.queryByText(SAVED_WORDS)).not.toBeInTheDocument();
  });

  it('a refused save lists every problem and keeps the edit', async () => {
    const user = userEvent.setup();
    const { box } = await render({
      [PUT_INSTRUCTIONS]: respond(400, { error: 'invalid_prompt', code: 'INVALID_PROMPT', problems: ['Unknown placeholder: frist_name', 'Section "call_plan" is never closed — add {{/call_plan}} (line 4)'], requestId: 'r1' }),
    });
    await user.type(box, ' x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    const items = within(alert).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Unknown placeholder: frist_name', 'Section "call_plan" is never closed — add {{/call_plan}} (line 4)']);
    expect(screen.queryByText(SAVED_WORDS)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(`${DEFAULT_INSTRUCTIONS} x`);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a refused save also reads the problems from an error envelope', async () => {
    const user = userEvent.setup();
    const { box } = await render({
      [PUT_INSTRUCTIONS]: respond(400, { error: 'invalid_prompt', code: 'INVALID_PROMPT', details: { problems: ['Prompt is empty'] } }),
    });
    await user.type(box, ' x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(await screen.findByRole('alert')).findByText('Prompt is empty')).toBeInTheDocument();
  });

  it('when the check service is down, says so in the server words and saves nothing', async () => {
    const user = userEvent.setup();
    const { box } = await render({
      [PUT_INSTRUCTIONS]: respond(503, { error: 'prompt_check_unavailable', code: 'PROMPT_CHECK_UNAVAILABLE', message: "Can't check the prompt right now — try again in a minute", requestId: 'r1' }),
    });
    await user.type(box, ' x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't check the prompt right now — try again in a minute");
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows the character count against the limit, and turns Save off when the text is too long', async () => {
    const user = userEvent.setup();
    await render({ [LIST]: promptsResponse({ voicemail: promptState('voicemail', { defaultTemplate: 'x'.repeat(1_499) }) }) });
    await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
    const box = await screen.findByRole('textbox', { name: 'Voicemail message' });
    expect(screen.getByText('1,499 / 1,500 characters')).toBeInTheDocument();
    await user.type(box, 'y');
    expect(screen.getByText('1,500 / 1,500 characters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.type(box, 'z');
    expect(screen.getByText('1,501 / 1,500 characters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await user.type(box, '{Backspace}');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('counts the instructions against their own, larger limit', async () => {
    await render();
    expect(AGENT_PROMPT_MAX_CHARS.instructions).toBe(60_000);
    expect(screen.getByText(`${DEFAULT_INSTRUCTIONS.length} / 60,000 characters`)).toBeInTheDocument();
  });

  it('Preview shows the sample call rendered, and Save is not called', async () => {
    const user = userEvent.setup();
    const { calls, box } = await render({
      [PREVIEW_INSTRUCTIONS]: { defaultTemplate: DEFAULT_INSTRUCTIONS, placeholders: [], rendered: 'You are Alex, calling for GG Homes.', problems: [] },
    });
    await user.type(box, ' Be kind.');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const panel = await screen.findByRole('region', { name: 'Preview' });
    expect(within(panel).getByText('You are Alex, calling for GG Homes.')).toBeInTheDocument();
    expect(sent(calls, PREVIEW_INSTRUCTIONS).map((c) => c.body)).toEqual([{ template: `${DEFAULT_INSTRUCTIONS} Be kind.` }]);
    expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
  });

  it('Preview with problems lists them instead of text', async () => {
    const user = userEvent.setup();
    const { box } = await render({
      [PREVIEW_INSTRUCTIONS]: { defaultTemplate: DEFAULT_INSTRUCTIONS, placeholders: [], rendered: null, problems: ['Unknown placeholder: nope'] },
    });
    await user.type(box, ' x');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const panel = await screen.findByRole('region', { name: 'Preview' });
    expect(within(panel).getByText('Unknown placeholder: nope')).toBeInTheDocument();
  });

  it('a preview the server refuses with problems (a text over the limit) lists them in the preview panel', async () => {
    const user = userEvent.setup();
    const { box } = await render({
      [PREVIEW_INSTRUCTIONS]: respond(400, { error: 'invalid_prompt', code: 'INVALID_PROMPT', problems: ["The agent's instructions can be at most 60,000 characters; this one is 60,001."] }),
    });
    await user.type(box, ' x');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const panel = await screen.findByRole('region', { name: 'Preview' });
    expect(within(panel).getByText("The agent's instructions can be at most 60,000 characters; this one is 60,001.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a preview that cannot be checked says so, and editing clears a preview that no longer matches', async () => {
    const user = userEvent.setup();
    const answers: Record<string, unknown> = { [PREVIEW_INSTRUCTIONS]: respond(503, { error: 'prompt_check_unavailable', code: 'PROMPT_CHECK_UNAVAILABLE', message: "Can't check the prompt right now — try again in a minute", requestId: 'r1' }) };
    const { box } = await render(answers);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't check the prompt right now — try again in a minute");
    answers[PREVIEW_INSTRUCTIONS] = { defaultTemplate: DEFAULT_INSTRUCTIONS, placeholders: [], rendered: 'Hello from the sample call.', problems: [] };
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const panel = await screen.findByRole('region', { name: 'Preview' });
    expect(within(panel).getByText('Hello from the sample call.')).toBeInTheDocument();
    await user.type(box, '!');
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('Reset to default asks first, then saves null and puts the default back in the editor', async () => {
    const user = userEvent.setup();
    const saved = 'My own prompt for {{agent_name}}.';
    const { calls } = await render({
      [LIST]: promptsResponse({ instructions: promptState('instructions', { active: saved, updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com', versions: [version()] }) }),
      [PUT_INSTRUCTIONS]: promptState('instructions', { active: null, updatedAt: SAVED_AT, updatedByEmail: 'admin@gg.co', versions: [version({ id: VERSION_B, isDefault: true, chars: 0 }), version()] }),
    });
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Go back to the built-in prompt?');
    expect(dialog).toHaveTextContent('Your saved versions stay in Previous versions; unsaved edits will be lost.');
    expect(dialog).not.toHaveTextContent('Your edits stay in Previous versions');
    expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(sent(calls, PUT_INSTRUCTIONS).map((c) => c.body)).toEqual([{ template: null }]));
    expect(await screen.findByText('Using the default')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(DEFAULT_INSTRUCTIONS);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Reset to default is off while the default is in use and nothing is edited, and on once something is', async () => {
    const user = userEvent.setup();
    const { box } = await render();
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
    await user.type(box, ' x');
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeEnabled();
  });

  it('Reset to default with unsaved edits while the default is already in use only restores the editor: no save, no new version', async () => {
    const user = userEvent.setup();
    const { calls, box } = await render();
    await user.type(box, ' my draft');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Go back to the built-in prompt?');
    // Nothing was saved, so it does not claim the edits stay in Previous versions: it says they are discarded.
    expect(dialog).not.toHaveTextContent('stay in Previous versions');
    expect(dialog).toHaveTextContent('unsaved edits');
    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(DEFAULT_INSTRUCTIONS));
    expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(screen.getByText('Using the default')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText('Back to the default — the next call uses it.')).not.toBeInTheDocument();
  });

  it('cancelling a reset of an unsaved draft keeps the draft', async () => {
    const user = userEvent.setup();
    const { calls, box } = await render();
    await user.type(box, ' my draft');
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(`${DEFAULT_INSTRUCTIONS} my draft`);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('Reset to default with unsaved edits on top of a saved version still saves the reset, and the dialog says the edits will be lost', async () => {
    const user = userEvent.setup();
    const saved = 'My own prompt for {{agent_name}}.';
    const { calls, box } = await render({
      [LIST]: promptsResponse({ instructions: promptState('instructions', { active: saved, updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com', versions: [version()] }) }),
      [PUT_INSTRUCTIONS]: promptState('instructions', { active: null, updatedAt: SAVED_AT, updatedByEmail: 'admin@gg.co', versions: [version({ id: VERSION_B, isDefault: true, chars: 0 }), version()] }),
    });
    await user.type(box, ' plus a draft');
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('unsaved edits will be lost');
    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(sent(calls, PUT_INSTRUCTIONS).map((c) => c.body)).toEqual([{ template: null }]));
    expect(await screen.findByText('Using the default')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(DEFAULT_INSTRUCTIONS);
  });

  it('cancelling the reset saves nothing', async () => {
    const user = userEvent.setup();
    const { calls } = await render({ [LIST]: promptsResponse({ instructions: promptState('instructions', { active: 'My own prompt.', updatedAt: SAVED_AT, updatedByEmail: 'grant@gghomes.com' }) }) });
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
  });

  it('the Voicemail tab edits and saves the voicemail kind', async () => {
    const user = userEvent.setup();
    const typed = `${DEFAULT_VOICEMAIL} Call back soon.`;
    const { calls } = await render({ [PUT_VOICEMAIL]: promptState('voicemail', { active: typed, updatedAt: SAVED_AT, updatedByEmail: 'admin@gg.co' }) });
    await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
    const box = await screen.findByRole('textbox', { name: 'Voicemail message' });
    expect(box).toHaveValue(DEFAULT_VOICEMAIL);
    expect(screen.queryByRole('textbox', { name: 'Call instructions' })).not.toBeInTheDocument();
    await user.type(box, ' Call back soon.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(SAVED_WORDS)).toBeInTheDocument();
    expect(sent(calls, PUT_VOICEMAIL).map((c) => c.body)).toEqual([{ template: typed }]);
    expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
  });

  it('has three tabs, in order: the call instructions, the voicemail message and the inbound calls', async () => {
    await render();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Call instructions', 'Voicemail message', 'Inbound calls']);
    expect(screen.getByRole('tab', { name: 'Inbound calls' })).toHaveAttribute('aria-selected', 'false');
  });

  it('the Inbound calls tab edits and saves the inbound kind', async () => {
    const user = userEvent.setup();
    const typed = `${DEFAULT_INBOUND} Be brief.`;
    const { calls } = await render({ [PUT_INBOUND]: promptState('inbound', { active: typed, updatedAt: SAVED_AT, updatedByEmail: 'admin@gg.co' }) });
    await user.click(screen.getByRole('tab', { name: 'Inbound calls' }));
    const box = await screen.findByRole('textbox', { name: 'Inbound calls' });
    expect(box).toHaveValue(DEFAULT_INBOUND);
    expect(screen.queryByRole('textbox', { name: 'Call instructions' })).not.toBeInTheDocument();
    await user.type(box, ' Be brief.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(SAVED_WORDS)).toBeInTheDocument();
    expect(sent(calls, PUT_INBOUND).map((c) => c.body)).toEqual([{ template: typed }]);
    expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
    expect(sent(calls, PUT_VOICEMAIL)).toEqual([]);
  });

  it('the Inbound calls tab, and only it, says the fixed phone-line rules are added after the prompt (final review M-7)', async () => {
    const user = userEvent.setup();
    const words =
      "After this prompt, the system adds a few fixed phone-line rules: save what the caller says quietly (never read it out), end the call when they're done, and the number they're calling from.";
    await render();
    expect(screen.queryByText(words)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
    await screen.findByRole('textbox', { name: 'Voicemail message' });
    expect(screen.queryByText(words)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Inbound calls' }));
    await screen.findByRole('textbox', { name: 'Inbound calls' });
    expect(screen.getByText(words)).toBeInTheDocument();
  });

  it('opens on the tab it is asked to, and on the call instructions otherwise', async () => {
    stubApi({ [LIST]: promptsResponse() });
    renderWithRouter(<AgentPromptPage initialKind="inbound" />, { isAdmin: true });
    expect(await screen.findByRole('textbox', { name: 'Inbound calls' })).toHaveValue(DEFAULT_INBOUND);
    expect(screen.getByRole('tab', { name: 'Inbound calls' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('textbox', { name: 'Call instructions' })).not.toBeInTheDocument();
  });

  it('lists the placeholders the server allows, with their kind and meaning', async () => {
    const user = userEvent.setup();
    await render();
    const details = screen.getByText('Placeholders you can use').closest('details');
    expect(details).not.toBeNull();
    const list = within(details as HTMLElement).getByRole('list', { name: 'Placeholders' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('agent_name');
    expect(rows[0]).toHaveTextContent('text');
    expect(rows[0]).toHaveTextContent('the name the agent introduces itself with');
    expect(rows[2]).toHaveTextContent('call_plan');
    expect(rows[2]).toHaveTextContent('section');
    // Each kind has its own list.
    await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
    await screen.findByRole('textbox', { name: 'Voicemail message' });
    expect(within(screen.getByRole('list', { name: 'Placeholders' })).getAllByRole('listitem')).toHaveLength(3);
  });

  describe('previous versions', () => {
    const body = 'An older prompt for {{agent_name}}.';
    const versions = [
      version({ id: VERSION_B, createdAt: '2026-10-16T21:00:00.000Z', createdByEmail: 'admin@gg.co', isDefault: true, chars: 0 }),
      version({ id: VERSION_A, createdAt: SAVED_AT, createdByEmail: 'grant@gghomes.com', chars: body.length }),
    ];

    it('lists each with its time, who saved it and a default badge', async () => {
      await render({ [LIST]: promptsResponse({ instructions: promptState('instructions', { versions }) }) });
      const list = screen.getByRole('list', { name: 'Previous versions' });
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent(formatDateTime('2026-10-16T21:00:00.000Z'));
      expect(rows[0]).toHaveTextContent('admin@gg.co');
      expect(rows[0]).toHaveTextContent('default');
      expect(rows[1]).toHaveTextContent(formatDateTime(SAVED_AT));
      expect(rows[1]).toHaveTextContent('grant@gghomes.com');
      expect(rows[1]).not.toHaveTextContent('default');
    });

    it('says when there are none', async () => {
      await render();
      expect(screen.getByText('No earlier versions yet.')).toBeInTheDocument();
    });

    it('Load puts the version in the editor, unsaved, and Save then saves it', async () => {
      const user = userEvent.setup();
      const { calls } = await render({
        [LIST]: promptsResponse({ instructions: promptState('instructions', { versions }) }),
        [`GET /api/settings/agent-prompts/instructions/versions/${VERSION_A}`]: { id: VERSION_A, body },
        [PUT_INSTRUCTIONS]: promptState('instructions', { active: body, updatedAt: SAVED_AT, updatedByEmail: 'admin@gg.co', versions }),
      });
      await user.click(screen.getByRole('button', { name: `Load the version saved ${formatDateTime(SAVED_AT)}` }));
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(body));
      expect(sent(calls, PUT_INSTRUCTIONS)).toEqual([]);
      expect(screen.getByText('Using the default')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(SAVED_WORDS)).toBeInTheDocument();
      expect(sent(calls, PUT_INSTRUCTIONS).map((c) => c.body)).toEqual([{ template: body }]);
    });

    it('Load over unsaved edits asks first: Cancel keeps the edit and fetches nothing, OK replaces it', async () => {
      const user = userEvent.setup();
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      const route = `GET /api/settings/agent-prompts/instructions/versions/${VERSION_A}`;
      const { calls, box } = await render({
        [LIST]: promptsResponse({ instructions: promptState('instructions', { versions }) }),
        [route]: { id: VERSION_A, body },
      });
      await user.type(box, ' mine');
      const load = screen.getByRole('button', { name: `Load the version saved ${formatDateTime(SAVED_AT)}` });
      await user.click(load);
      expect(confirm).toHaveBeenCalledWith('Replace your unsaved changes with this version?');
      expect(sent(calls, route)).toEqual([]);
      expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(`${DEFAULT_INSTRUCTIONS} mine`);
      confirm.mockReturnValue(true);
      await user.click(load);
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(body));
    });

    it('Load of a reset-to-default version puts the built-in default in the editor', async () => {
      const user = userEvent.setup();
      const saved = 'My own prompt.';
      await render({
        [LIST]: promptsResponse({ instructions: promptState('instructions', { active: saved, updatedAt: SAVED_AT, versions }) }),
        [`GET /api/settings/agent-prompts/instructions/versions/${VERSION_B}`]: { id: VERSION_B, body: null },
      });
      await user.click(screen.getByRole('button', { name: `Load the version saved ${formatDateTime('2026-10-16T21:00:00.000Z')}` }));
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(DEFAULT_INSTRUCTIONS));
    });

    it('a version that cannot be loaded says so and leaves the editor alone', async () => {
      const user = userEvent.setup();
      await render({
        [LIST]: promptsResponse({ instructions: promptState('instructions', { versions }) }),
        [`GET /api/settings/agent-prompts/instructions/versions/${VERSION_A}`]: respond(404, { error: 'Not found', code: 'NOT_FOUND' }),
      });
      await user.click(screen.getByRole('button', { name: `Load the version saved ${formatDateTime(SAVED_AT)}` }));
      expect(await screen.findByRole('alert')).toHaveTextContent("That version isn't there any more.");
      expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(DEFAULT_INSTRUCTIONS);
    });
  });

  it('when the prompts cannot be read, says so in the server words instead of showing an empty editor', async () => {
    stubApi({ [LIST]: respond(503, { error: 'prompt_check_unavailable', code: 'PROMPT_CHECK_UNAVAILABLE', message: "Can't check the prompt right now — try again in a minute", requestId: 'r1' }) });
    renderWithRouter(<AgentPromptPage />, { isAdmin: true });
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't check the prompt right now — try again in a minute");
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('when the prompts fail to load for another reason, shows that reason', async () => {
    stubApi({ [LIST]: respond(500, { error: 'Something went wrong on our side. Try again in a minute.', code: 'INTERNAL_ERROR' }) });
    renderWithRouter(<AgentPromptPage />, { isAdmin: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again in a minute.');
  });

  describe('unsaved edits', () => {
    it('switching tabs asks first: Cancel stays on the edit, OK switches', async () => {
      const user = userEvent.setup();
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      const { box } = await render();
      await user.type(box, ' x');
      await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('textbox', { name: 'Call instructions' })).toHaveValue(`${DEFAULT_INSTRUCTIONS} x`);
      confirm.mockReturnValue(true);
      await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
      expect(await screen.findByRole('textbox', { name: 'Voicemail message' })).toHaveValue(DEFAULT_VOICEMAIL);
    });

    it('switching tabs with nothing edited asks nothing', async () => {
      const user = userEvent.setup();
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      await render();
      await user.click(screen.getByRole('tab', { name: 'Voicemail message' }));
      expect(await screen.findByRole('textbox', { name: 'Voicemail message' })).toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
    });

    it('leaving the page asks first (the router, and a reload or closing the tab), and asks nothing once saved', async () => {
      const user = userEvent.setup();
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      const typed = `${DEFAULT_INSTRUCTIONS} x`;
      const { box, router } = await render({ [PUT_INSTRUCTIONS]: promptState('instructions', { active: typed, updatedAt: SAVED_AT }) });
      const quiet = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(quiet);
      expect(quiet.defaultPrevented).toBe(false);
      await user.type(box, ' x');
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      // A blocked navigation never settles: don't wait on it.
      void router.navigate({ to: '/settings' as never });
      await waitFor(() => expect(confirm).toHaveBeenCalledWith('You have unsaved changes to this prompt. Leave without saving?'));
      expect(router.state.location.pathname).toBe('/');
      confirm.mockReturnValue(true);
      await router.navigate({ to: '/settings' as never });
      await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
    });

    it('once saved, leaving asks nothing', async () => {
      const user = userEvent.setup();
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      const typed = `${DEFAULT_INSTRUCTIONS} x`;
      const { box, router } = await render({ [PUT_INSTRUCTIONS]: promptState('instructions', { active: typed, updatedAt: SAVED_AT }) });
      await user.type(box, ' x');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(SAVED_WORDS)).toBeInTheDocument();
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
      await router.navigate({ to: '/settings' as never });
      await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
