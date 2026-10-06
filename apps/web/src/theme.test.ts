import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Line endings depend on the checkout (core.autocrlf).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('./index.css');
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
const src = fileURLToPath(new URL('.', import.meta.url));
const components = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'vendor' ? [] : walk(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [readFileSync(path, 'utf8')] : [];
  });
})(src).join('\n');
/** The body of the first rule whose selector is exactly `selector`. */
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS rule: ${selector}`).not.toBeNull();
  return match![1];
};

// The console is shadcn/ui on DeepSeek Harness's own design tokens (src/index.css).
describe('DSH theme contract', () => {
  it('bundles the exact pinned DSH theme, fonts and license notices, with nothing remote', () => {
    for (const name of vendorNames) {
      const production = readFileSync(new URL(`./vendor/${name}`, import.meta.url));
      const approved = readFileSync(
        new URL(`../../../docs/prototype/vendor/${name}`, import.meta.url),
      );
      expect(production.equals(approved), name).toBe(true);
    }
    expect(css.match(/@import\s+'\.\/vendor\//g)).toHaveLength(5);
    expect(css + html + read('./vendor/brand-font.css')).not.toMatch(
      /(?:@import|url\()\s*['"]?https?:|fonts\.googleapis|fonts\.gstatic/i,
    );
  });

  it('defines every color through DSH tokens and resolves each one', () => {
    const definitions = new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    for (const match of css.matchAll(/var\((--ds[\w-]+)/g))
      expect(definitions.has(match[1]), `Undefined DSH token ${match[1]}`).toBe(true);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i);
    // Components use theme utilities, never ad-hoc colors.
    expect(components).not.toMatch(/#[\da-fA-F]{6}\b|\b(?:bg|text|border)-\[#|rgba?\(/);
  });

  it('maps shadcn roles onto DSH roles in light and dark', () => {
    const light = rule('body');
    expect(light).toContain('--primary: var(--dsw-alias-button-primary-fill)');
    expect(light).toContain('--foreground: var(--dsw-alias-label-primary)');
    expect(light).toContain('--muted-foreground: var(--dsw-alias-label-secondary)');
    expect(light).toContain('--border: var(--dsw-alias-border-l3)');
    expect(light).toContain('--card: var(--dsw-alias-bg-layer-2)');
    expect(rule('body[data-ds-dark-theme]')).toContain('--sidebar: var(--dsw-static-neutral-bluish-900)');
    expect(css).toContain('@custom-variant dark (&:where([data-ds-dark-theme], [data-ds-dark-theme] *))');
    expect(css).toContain('--font-sans: var(--dsw-font-family)');
    expect(css).toContain('--radius-3xl: var(--dsw-radius-panel)');
    expect(css).toContain('--shadow-panel: var(--dsw-elevation-panel)');
  });

  it('keeps DSH type restraint and brief, optional motion', () => {
    expect(components).not.toMatch(/\bfont-(?:semibold|bold|extrabold|black)\b/);
    expect(css).toMatch(/\.swap\s*\{\s*animation:\s*swap-in (1[6-9]\d|2[01]\d|220)ms/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.swap\s*\{\s*animation:\s*none/);
  });

  it('keeps page-level layout responsive without horizontal scrolling', () => {
    // Flow columns size from zero so long paths or tool rows can never widen the page.
    expect(components).toMatch(/grid grid-cols-1 gap-2\.5/);
    expect(components).toMatch(/grid grid-cols-1 gap-7/);
    expect(components).toContain("'sidebar flex w-[280px]");
    expect(components).toContain('max-md:-translate-x-full max-md:invisible');
  });
});
