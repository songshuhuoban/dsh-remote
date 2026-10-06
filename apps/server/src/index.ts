import { createRelay } from "./server.ts";
const port = Number(process.env.PORT ?? 3000);
const relay = createRelay({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
  databasePath: process.env.DATABASE_PATH ?? ".data/relay.sqlite",
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(","),
  staticDir: process.env.WEB_DIST ?? "apps/web/dist",
  // "invite" fails closed: without the code, registration stays off.
  registration:
    process.env.REGISTRATION === "enabled" ||
    (process.env.REGISTRATION === "invite" && !!process.env.REGISTRATION_INVITE_CODE),
  inviteCode: process.env.REGISTRATION_INVITE_CODE || undefined,
  publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
  secureCookies: process.env.SECURE_COOKIES === "true",
});
console.log(`DSH Remote relay listening on ${relay.server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await relay.stop();
    process.exit(0);
  });
