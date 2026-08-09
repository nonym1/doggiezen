// netlify/functions/api.js
// Entry point for the DoggieZen backend on Netlify Functions. This file contains NO game
// logic of its own — it only wires the existing, unmodified Express app from ../../server.js
// (createApp) to Netlify's Lambda-compatible function runtime:
//   - serverless-http adapts the Express app to Netlify's (event, context) => response
//     handler shape, replacing app.listen() from server.js's own bootstrap block (which
//     never runs here, since this file requires server.js rather than executing it directly)
//   - db-blobs.js / store-blobs.js are Netlify Blobs-backed implementations of the exact
//     same db/store interfaces server.js already expected (it was written to accept them
//     via dependency injection — see createApp({db, store, ...}) in server.js) — used in
//     place of db.js (better-sqlite3, which needs a persistent local file Netlify Functions
//     don't have) and store.js's in-memory/Redis options (in-memory doesn't survive between
//     invocations; Redis was declined in favor of Blobs).
//
// A fresh db + store + app is built on every invocation. This looks wasteful compared to
// reusing a warm container, but db/store MUST be per-invocation (see the comment at the top
// of db-blobs.js — their small in-memory cache would otherwise go stale between requests
// that hit the same warm container), and createApp() itself is just wiring Express route
// definitions — a handful of function calls, not a real cost — so there is no benefit to
// caching it separately once db/store must already be rebuilt every time.

const serverless = require('serverless-http');
const { connectLambda } = require('@netlify/blobs');
const { createApp } = require('../../server');
const { createDb } = require('../../db-blobs');
const { createStore } = require('../../store-blobs');

exports.handler = async (event, context) => {
  // Required by @netlify/blobs so getStore() (inside db-blobs.js/store-blobs.js) knows
  // which site/deploy it's running for. See:
  // https://docs.netlify.com/build/data-and-storage/netlify-blobs/
  connectLambda(event);

  // Netlify puts the caller's real IP in this header; server.js does
  // `app.set('trust proxy', true)` and reads req.ip via X-Forwarded-For, so mirror it there
  // for the IP-based rate limiter in server.js to see the real visitor instead of Netlify's
  // edge IP.
  if (event.headers && event.headers['x-nf-client-connection-ip'] && !event.headers['x-forwarded-for']) {
    event.headers['x-forwarded-for'] = event.headers['x-nf-client-connection-ip'];
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'Server misconfigured: TELEGRAM_BOT_TOKEN is not set (Netlify: Site settings > Environment variables)',
      }),
    };
  }

  const app = createApp({
    db: createDb(),
    store: createStore(),
    botToken: BOT_TOKEN,
    allowedOrigin: process.env.ALLOWED_ORIGIN,
    zenPassWallet: process.env.ZEN_PASS_WALLET || null,
    toncenterApiKey: process.env.TONCENTER_API_KEY || null,
    tonNetwork: process.env.TON_NETWORK || 'mainnet',
  });

  const wrapped = serverless(app);
  return wrapped(event, context);
};
