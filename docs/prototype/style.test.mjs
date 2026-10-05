import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('style.css',import.meta.url),'utf8');
const theme=(await Promise.all(['base.css','design-platform.css','gradient-shadow-text.css','corner-shape.css'].map(x=>readFile(new URL('vendor/'+x,import.meta.url),'utf8')))).join('\n');
test('every upstream semantic token used by the prototype is defined in copied sheets',()=>{const definitions=new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map(x=>x[1]));for(const x of css.matchAll(/var\((--ds[\w-]+)/g))assert.ok(definitions.has(x[1]),x[1]);});
test('feature stylesheet does not fork light/dark palette or use heavy headings',()=>{assert.doesNotMatch(css,/data-ds-dark-theme/);assert.doesNotMatch(css,/font-weight\s*:\s*(?:[6-9]00|bold)/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/:focus-visible/);assert.match(css,/@media\(max-width:760px\)/);});
test('minimum mobile viewport and dialog sizing have explicit recovery-safe constraints',()=>{assert.match(css,/max-height:calc\(100dvh - 24px\)/);assert.match(css,/overflow:auto/);assert.match(css,/env\(safe-area-inset-bottom\)/);assert.match(css,/\.modal-backdrop.*z-index:20/s);});
