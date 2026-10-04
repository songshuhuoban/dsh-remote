// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelSettings } from './model-settings';
import { runCommand } from './api';
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), runCommand: vi.fn() }));
beforeAll(() => { Object.assign(HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); }, close(this: HTMLDialogElement) { this.removeAttribute('open'); } }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const catalog = { default: { provider: 'deepseek', model: 'deepseek-flash' }, groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] };
function setup(current: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { instanceId: 'i', sessionId: 's', controllerId: 'c', canWrite: true, write: vi.fn(), current, onClose: vi.fn() };
  const view = render(<QueryClientProvider client={client}><ModelSettings {...props} /></QueryClientProvider>);
  return { ...view, client, props, update: (current: Record<string, unknown>) => view.rerender(<QueryClientProvider client={client}><ModelSettings {...props} current={current} /></QueryClientProvider>) };
}
describe('model selection hydration', () => {
  it('hydrates a partial initial selection from the actual delayed host catalog', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(runCommand).mockImplementation(() => new Promise((done) => { resolve = done; }));
    setup({ provider: 'deepseek' });
    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('');
    await act(async () => { resolve({ modelCatalog: catalog }); });
    await waitFor(() => expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('deepseek-flash'));
    expect((screen.getByRole('button', { name: '应用配置' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('updates from late session projection but does not overwrite a deliberate user edit', async () => {
    vi.mocked(runCommand).mockResolvedValue({ modelCatalog: catalog });
    const view = setup();
    await waitFor(() => expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('deepseek-flash'));
    view.update({ provider: 'deepseek', model: 'deepseek-chat' });
    await waitFor(() => expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('deepseek-chat'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'deepseek-flash' } });
    await act(async () => { view.client.setQueryData(['remote', 'i', 'settings', 's'], { modelCatalog: catalog, projections: { values: { modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' } } } } }); });
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('deepseek-flash');
  });
});
