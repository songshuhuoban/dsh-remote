export type Draft = {
  text: string;
  mode: 'queue' | 'steer';
  references: string[];
  files: { name: string; content: Record<string, unknown> }[];
};
const empty: Draft = { text: '', mode: 'queue', references: [], files: [] };
export function readDraft(key: string): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      !value ||
      typeof value.text !== 'string' ||
      !Array.isArray(value.references) ||
      !Array.isArray(value.files)
    )
      return empty;
    return {
      text: value.text.slice(0, 100000),
      mode: value.mode === 'steer' ? 'steer' : 'queue',
      references: value.references.filter((id: unknown) => typeof id === 'string').slice(0, 8),
      files: value.files.slice(0, 4),
    };
  } catch {
    return empty;
  }
}
export function saveDraft(key: string, draft: Draft): boolean {
  try {
    if (!draft.text && !draft.files.length && !draft.references.length)
      sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
