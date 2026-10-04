/** Real upstream DSH process, real plugin and real Bun connector. Only model output is deterministic. */
import { test, expect } from '@playwright/test';
test('actual DSH browser flow: takeover, history, prompt, file, model, queue, approval and cancellation', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('real-runtime@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill('local-fixture-password-only');
  await page.getByLabel('当前设备名称').fill('Playwright actual DSH');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('heading', { name: /Actual upstream source/ })).toBeVisible();
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  // Other sessions remain visible. A read alone must not take control.
  await expect(page.getByRole('button', { name: '接管', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '接管', exact: true }).click();
  await page.getByRole('button', { name: '保持只读', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '接管', exact: true }).click();
  await page.getByRole('button', { name: '确认接管', exact: true }).click();
  await expect(page.getByText('你拥有控制权', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: /新建会话/ })
    .last()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: '创建会话', exact: true }).click();
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('Actual browser prompt to the real DSH runtime.');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  // DSH may append separate runtime-context user records; identify the submitted message.
  await expect(page.locator('.user-message').filter({ hasText: 'Actual browser prompt' })).toHaveCount(1);
  await expect(
    page.locator('.message-text').filter({ hasText: 'REAL_DSH_PIPELINE_OK' }).first(),
  ).toBeVisible({ timeout: 20000 });
  await page.screenshot({
    path: testInfo.outputPath('actual-dsh-conversation-desktop.png'),
    fullPage: true,
  });
  // Reload hydrates durable history and keeps the lease bound to the same controller.
  await page.reload();
  await expect(
    page.locator('.message-text').filter({ hasText: 'REAL_DSH_PIPELINE_OK' }).first(),
  ).toBeVisible({ timeout: 20000 });
  await page.locator('.model-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('模型', { exact: true })).not.toHaveValue('');
  await dialog.getByRole('button', { name: '应用配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Real DSH file receipt then prompt admission.
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'browser-fixture.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Browser attachment fixture'),
    });
  await expect(page.locator('.attachment-list')).toContainText('browser-fixture.txt');
  await input.fill('Read this isolated uploaded file.');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.attachment-list')).toHaveCount(0);
  await expect(input).toHaveValue('');
  // The fixture requests the actual DSH approval service before one isolated test effect.
  await input.fill('APPROVAL_INTEGRATION deny this browser test action.');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('等待你的审批', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('remote-e2e-fixture', { exact: true })).toBeVisible();
  await input.fill('Browser queue item');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.queue-list')).toContainText('Browser queue item');
  await page.getByRole('button', { name: '编辑队列项', exact: true }).click();
  await page
    .getByRole('textbox', { name: '队列消息', exact: true })
    .fill('Browser edited queue item');
  await page.getByRole('button', { name: '保存队列消息', exact: true }).click();
  await expect(page.locator('.queue-list')).toContainText('Browser edited queue item');
  await page.getByRole('button', { name: '移除队列项', exact: true }).click();
  await expect(page.locator('.queue-list')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('actual-dsh-approval-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByText('等待你的审批', { exact: true })).toHaveCount(0);
  await input.fill('APPROVAL_INTEGRATION hold this action until cancelled.');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('等待你的审批', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.getByText('等待你的审批', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '释放', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('actual-dsh-conversation-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
