#!/usr/bin/env node
// One-time OAuth helper: obtain a Gmail READ-ONLY refresh token for the app.
//
// Prereq: a Google Cloud OAuth client of type **Desktop app** (Gmail API
// enabled). Put its id/secret in .env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// (or pass --id / --secret). schlierf.eu is Google Workspace → set the OAuth
// consent screen to **Internal**, so no Google verification is required.
//
// Run:   node scripts/gmail-auth.mjs
// It starts a localhost listener, prints a Google consent URL, you approve as
// juergen@schlierf.eu, and it prints the GOOGLE_REFRESH_TOKEN to paste into .env.
//
// Zero dependencies (Node >= 18).

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// readonly = search/read invoices; send = forward them to the Qonto inbox.
const SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PORT = 53682; // loopback redirect port
const REDIRECT = `http://localhost:${PORT}`;

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = {};
  for (const name of [".env", ".env.local"]) {
    const p = resolve(APP_ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const env = loadEnv();
const clientId = arg("--id") || process.env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const clientSecret = arg("--secret") || process.env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing client credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env,\n" +
      "or pass --id <client_id> --secret <client_secret>.",
  );
  process.exit(1);
}

const authUrl =
  `${AUTH_URL}?` +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
  }).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No ?code in callback.");
    return;
  }
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok || !json.refresh_token) {
      res.writeHead(500).end("Token exchange failed — see terminal.");
      console.error("\nToken exchange failed:", JSON.stringify(json, null, 2));
      console.error(
        json.refresh_token === undefined
          ? "\nNo refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and retry (the script already sends prompt=consent)."
          : "",
      );
      server.close();
      process.exit(1);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      "<h2>✅ Connected. You can close this tab and return to the terminal.</h2>",
    );
    console.log("\n✅ Success. Add this line to your .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${json.refresh_token}\n`);
    console.log("(also ensure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set there)");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end("Error — see terminal.");
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("Gmail OAuth — open this URL in your browser and sign in as the mailbox owner:\n");
  console.log(authUrl + "\n");
  console.log(`Waiting for the Google redirect to ${REDIRECT} …`);
});
