import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export default defineConfig({
 testDir:'.',testMatch:'walkthrough.spec.mjs',timeout:30000,workers:1,
 reporter:[['list'],['json',{outputFile:'docs/prototype/evidence/browser-results.json'}]],
 outputDir:'evidence/browser-artifacts',
 use:{baseURL:'http://127.0.0.1:4179',headless:true,trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}},
 projects:[{name:'desktop-light',use:{viewport:{width:1440,height:1000}}},{name:'mobile-light',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}},{name:'desktop-dark',use:{viewport:{width:1440,height:1000}}},{name:'mobile-dark',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}],
 webServer:{command:'node docs/prototype/server.mjs',cwd:root,url:'http://127.0.0.1:4179',reuseExistingServer:false,timeout:10000},
});
