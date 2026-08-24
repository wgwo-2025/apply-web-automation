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
 * Returns the next unused account WITHOUT marking it. Marking is deferred to
 * markAccountUsed(), called once login actually succeeds.
 *
 * An earlier version marked on claim, reasoning that a half-walked application
 * is spent either way. That was too conservative: a run that dies BEFORE login
 * — a bad selector, a Cloudflare stall — never touches the application, and
 * marking it used threw away a perfectly good account. Three were burned that
 * way while the login selectors were being fixed.
 */
function claimAccount() {
  const pool = readPool();
  const account = (pool.accounts || []).find((a) => !a.used);
  if (!account) {
    throw new Error(
      `Every account in accounts.json is used (${(pool.accounts || []).length} total). ` +
      'If runs failed before reaching the funnel, their applications are untouched — ' +
      'set "used": false on those entries. Otherwise seed more (see the README).'
    );
  }
  return account;
}

/** Marks an account spent. Called after login succeeds, not before. */
function markAccountUsed(email) {
  const pool = readPool();
  const account = (pool.accounts || []).find((a) => a.email === email);
  if (!account) return;
  account.used = true;
  fs.writeFileSync(POOL_PATH, `${JSON.stringify(pool, null, 2)}\n`);
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

module.exports = { resolveAccount, claimAccount, markAccountUsed, readPool, POOL_PATH };
