import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Line endings depend on the checkout (core.autocrlf); selectors below are written with "\n".
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('./styles.css');
const html = read('../index.html');
const vendorNames = [
  'base.css',
  'design-platform.css',
  'brand-font.css',
  'gradient-shadow-text.css',
  'corner-shape.css',
  'montserrat-light.woff2',
  'montserrat-regular.woff2',
  'montserrat-medium.woff2',
  'DSH-LICENSE',
  'Montserrat-OFL.txt',
];
const theme = vendorNames
  .filter((name) => name.endsWith('.css'))
  .map((name) => read(`./vendor/${name}`))
  .join('\n');
const rule = (selector: string, source = css) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS rule: ${selector}`).not.toBeNull();
  return match![1];
};

// These tests enforce the adopted design contract, not browser pixel or touch QA.
describe('pinned Harness appearance contract', () => {
  it('bundles the exact approved local theme, fonts and license notices', () => {
    for (const name of vendorNames) {
      const production = readFileSync(new URL(`./vendor/${name}`, import.meta.url));
      const approved = readFileSync(
        new URL(`../../../docs/prototype/vendor/${name}`, import.meta.url),
      );
      expect(production.equals(approved), name).toBe(true);
    }
    expect(css.match(/@import\s+['"]\.\/vendor\//g)).toHaveLength(5);
    expect(css + html + read('./vendor/brand-font.css')).not.toMatch(
      /(?:@import|url\()\s*['"]?https?:|fonts\.googleapis|fonts\.gstatic|DM Sans|Noto Sans SC|IBM Plex/i,
    );
  });

  it('resolves every feature token through the pinned theme', () => {
    const definitions = new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    for (const match of css.matchAll(/var\((--ds[\w-]+)/g)) {
      expect(definitions.has(match[1]), `Undefined theme token ${match[1]}`).toBe(true);
    }
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i);
    expect(css).not.toMatch(/var\(--(?:dark|green|lime|muted|border|subtle)\)/);
  });

  it('leaves dark palette ownership upstream and uses restrained feature weights', () => {
    expect(theme).toContain('body[data-ds-dark-theme]');
    expect(rule('body[data-ds-dark-theme]').trim()).toBe('color-scheme: dark;');
    expect(css).not.toMatch(/font-weight:\s*(?:[6-9]00|bold)/);
    expect(rule('.brand')).toContain('font-family: var(--dsw-font-family-brand)');
    expect(rule('body')).toContain('font-family: var(--dsw-font-family)');
  });

  it('keeps one left edge and the approved conversation geometry', () => {
    expect(rule('.shell')).toContain('grid-template-columns: 248px minmax(0, 1fr)');
    expect(rule('.topbar')).toContain('min-height: 76px');
    expect(rule('.topbar')).toContain('padding: 12px 32px');
    expect(rule('.transcript')).toContain('padding: 16px 32px 24px');
    expect(rule('.transcript > *')).toContain('max-width: 780px');
    expect(rule('.composer-area')).toContain('max-width: 860px');
    expect(rule('.composer-area')).toContain('padding: 8px 32px');
    expect(rule('.composer-area')).not.toContain('margin: 0 auto');
    expect(rule('.composer')).toContain('border-radius: 28px');
    expect(rule('.modal')).toContain('border-radius: 28px');
    expect(rule('.modal-actions')).toContain('justify-content: flex-start');
    expect(rule('.approval-card')).toContain('border-radius: 20px');
    expect(rule('.approval-card')).toContain('var(--dsw-alias-state-warn-tertiary)');
    expect(rule('.send-button,\n.stop-button')).toMatch(/width: 34px;[\s\S]*height: 34px/);
    expect(rule('.send-button')).toContain('var(--dsw-alias-button-info-fill)');
  });

  it('groups with whitespace instead of rules and animates state changes briefly', () => {
    expect(css).not.toMatch(/border(?:-(?:top|right|bottom|left))?:\s*[\d.]+px solid/);
    expect(css).not.toMatch(/text-align:\s*center/);
    expect(rule('.swap')).toMatch(/animation: swap-in (\d+)ms ease-out/);
    const duration = Number(rule('.swap').match(/swap-in (\d+)ms/)![1]);
    expect(duration).toBeGreaterThanOrEqual(160);
    expect(duration).toBeLessThanOrEqual(220);
  });

  it('keeps read-only content readable and keyboard/reduced-motion paths available', () => {
    expect(rule('.composer.disabled')).not.toMatch(/opacity|pointer-events|display:\s*none/);
    expect(rule('.composer textarea:disabled')).toContain('opacity: 1');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('outline: 2px solid var(--dsw-alias-state-business-primary)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('scroll-behavior: auto !important');
  });

  it('gives narrow layouts an immediately hidden drawer and constrained flow surfaces', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(rule('.sidebar', mobile)).toContain('display: none');
    const drawer = rule('.sidebar.open', mobile);
    expect(drawer).toContain('display: flex');
    expect(drawer).toContain('width: min(290px, 85vw)');
    expect(drawer).not.toMatch(/transition|transform|left:\s*-/);
    expect(rule('.composer-tools,\n.composer-tools > div')).toContain('flex-wrap: wrap');
    expect(rule('.notice')).toContain('position: static');
    expect(rule('.approval-dock')).toContain('overflow: auto');
    expect(rule('.approval-dock')).toContain('max-height: min(40dvh, 360px)');
    expect(rule('.modal', mobile)).toContain('max-height: calc(100dvh - 24px)');
    expect(rule('.modal', mobile)).toContain('max-width: calc(100% - 24px)');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toContain('#15221c');
  });
});
