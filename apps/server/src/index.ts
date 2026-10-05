import { createRelay } from "./server.ts";
const port = Number(process.env.PORT ?? 3000);
const relay = createRelay({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
  databasePath: process.env.DATABASE_PATH ?? ".data/relay.sqlite",
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(","),
  staticDir: process.env.WEB_DIST ?? "apps/web/dist",
  registration: process.env.REGISTRATION === "enabled",
  secureCookies: process.env.SECURE_COOKIES === "true",
});
console.log(`DSH Remote relay listening on ${relay.server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await relay.stop();
    process.exit(0);
  });
