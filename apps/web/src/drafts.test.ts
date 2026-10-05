// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { readDraft, saveDraft } from './drafts';
afterEach(() => sessionStorage.clear());
it('retains a session-specific draft across navigation and removes it after a confirmed send', () => {
  const draft = { text: 'keep my work', mode: 'queue' as const, references: ['repo_1'], files: [] };
  expect(saveDraft('dsh.draft.controller.instance.session', draft)).toBe(true);
  expect(readDraft('dsh.draft.controller.instance.session')).toEqual(draft);
  expect(readDraft('dsh.draft.other.instance.session').text).toBe('');
  saveDraft('dsh.draft.controller.instance.session', { ...draft, text: '', references: [] });
  expect(sessionStorage.length).toBe(0);
});
