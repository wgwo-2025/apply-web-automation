/**
 * Pre-seeded borrower account pool.
 *
 * Each account is a Cognito-CONFIRMED user linked to an empty LoanPro
 * application at sub-status 60 (Started), so logging in lands straight on
 * /apply/loan-details and the rest of the funnel runs exactly as it would for
 * a brand-new applicant — without touching /create-account, the only path
 * Cloudflare challenges.
 *
 * Accounts are single-use: once a run walks the funnel, that application has
 * moved past Started and cannot seed another run. Seed more with
 * tools/test-user-manager.py (see README).
 */
const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, 'accounts.json');

function readPool() {
  if (!fs.existsSync(POOL_PATH)) {
    throw new Error(
      'accounts.json not found. Copy accounts.example.json to accounts.json and ' +
      'fill it with seeded accounts — see the README "Seeding accounts" section.'
    );
  }
  return JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
}

/**
 * Takes the next unused account and marks it used, so consecutive runs don't
 * collide on one application. Marking happens BEFORE the run rather than after:
 * a half-walked application is spent either way, so a crash must not hand the
 * same account to the next run.
 */
function claimAccount() {
  const pool = readPool();
  const account = (pool.accounts || []).find((a) => !a.used);
  if (!account) {
    throw new Error(
      `Every account in accounts.json is used (${(pool.accounts || []).length} total). ` +
      'Seed more — see the README "Seeding accounts" section.'
    );
  }
  account.used = true;
  fs.writeFileSync(POOL_PATH, `${JSON.stringify(pool, null, 2)}\n`);
  return account;
}

/**
 * Resolves the account for this run. An explicit email+password in the scenario
 * file wins; otherwise the pool is used.
 */
function resolveAccount(data) {
  const configured = data.account || {};
  if (configured.email && configured.password) {
    return { email: configured.email, password: configured.password };
  }
  return claimAccount();
}

module.exports = { resolveAccount, claimAccount, readPool, POOL_PATH };
