import { test, expect } from '@playwright/test';
const password = 'Synthetic-E2E-Only-2026!';
test('real relay: registration, offline instance, interrupted modal, reload, device and logout', async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('01-login-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(`web-e2e-${Date.now()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('当前设备名称').fill('桌面测试设备');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接你的第一台 DSH' })).toBeVisible();
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === 'dsh_session')?.httpOnly).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(['dsh.controller']);
  await page.getByRole('button', { name: '连接新实例', exact: true }).last().click();
  await page.getByLabel('实例名称').fill('应取消的实例');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '连接新实例', exact: true }).last().click();
  await page.getByLabel('实例名称').fill('Development workstation');
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实例已创建' })).toBeVisible();
  await expect(page.getByLabel('Connector 令牌')).not.toHaveValue('');
  await page.getByRole('button', { name: '我已保存，进入实例' }).click();
  await expect(page.getByRole('heading', { name: 'Development workstation' })).toBeVisible();
  await expect(page.getByRole('button', { name: '获取控制权', exact: true })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: /新建会话/ }).all())
    await expect(button).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('02-offline-console-desktop.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Development workstation' })).toBeVisible();
  await page.getByRole('button', { name: /控制设备/ }).click();
  await expect(page.getByRole('dialog')).toContainText('桌面测试设备');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  expect(errors).toEqual([]);
});
test('real relay: mobile viewport, responsive navigation and invalid sign in', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('not-an-account@example.test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(`mobile-e2e-${Date.now()}@example.test`);
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接你的第一台 DSH' })).toBeVisible();
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('button', { name: '关闭导航', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '连接新实例', exact: true }).first().click();
  await page.getByLabel('实例名称').fill('Mobile workspace');
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  await page.getByRole('button', { name: '我已保存，进入实例' }).click();
  await expect(page.getByRole('heading', { name: 'Mobile workspace' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('03-offline-console-mobile.png'),
    fullPage: true,
  });
});

for (const mobile of [false, true])
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Harness adoption: ${mobile ? 'mobile' : 'desktop'} ${colorScheme}, repository mapping and recovery exits`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await page.getByRole('button', { name: '创建账户', exact: true }).click();
      await page
        .getByLabel('邮箱', { exact: true })
        .fill(`adoption-${mobile}-${colorScheme}-${Date.now()}@example.test`);
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '创建账户', exact: true }).click();
      await page.getByRole('button', { name: '连接新实例', exact: true }).last().click();
      await page.getByLabel('实例名称').fill('Repository workstation');
      await page.getByRole('button', { name: '创建实例', exact: true }).click();
      await page.getByRole('button', { name: '我已保存，进入实例' }).click();
      if (mobile) {
        await page.getByRole('button', { name: '打开导航' }).click();
        await expect(page.locator('.sidebar.open')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.sidebar')).toBeHidden();
        await page.getByRole('button', { name: '打开导航' }).click();
      }
      await page.getByRole('button', { name: 'GitHub 仓库', exact: true }).click();
      await expect(page.getByText('此部署尚未配置 GitHub App', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '连接 GitHub', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '手动映射', exact: true }).click();
      await page.getByLabel('GitHub 仓库 URL').fill('https://github.com/example/review-worktree');
      await page.getByLabel('已有工作树绝对路径').fill('/allowed/../invalid');
      await page.getByRole('button', { name: '保存映射', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('请输入已有工作树的规范绝对路径');
      await page.getByLabel('已有工作树绝对路径').fill('/allowed/existing-worktree');
      await page.getByRole('button', { name: '保存映射', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('待主机验证 · 手动声明')).toBeVisible();
      await expect(page.getByRole('button', { name: '验证工作树' })).toBeDisabled();
      await page.getByRole('button', { name: '验证工作树' }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath('adopted-local-reference-scrolled.png'),
        animations: 'disabled',
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByRole('button', { name: '返回会话' }).click();
      if (mobile) await page.getByRole('button', { name: '打开导航' }).click();
      await page.getByRole('button', { name: '实例状态', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('最近心跳：尚未观测到');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath('adopted-observer-console.png'),
        animations: 'disabled',
        fullPage: true,
      });
    });
  }
