#!/usr/bin/env node
/**
 * Walks the go-dev.happymoney.com apply funnel end to end using data from a
 * JSON file (default: ./test-data.json, override with --data=path/to/file.json).
 *
 * Usage:
 *   npm install
 *   npm run install-browsers   # one-time
 *   npm run apply -- --data=./scenarios/my-scenario.json
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const {
  SUBSTATUS,
  loanproClient,
  applicationIdFromUrl,
  waitForSubStatus,
  advancePastUnderwriting,
} = require('./loanpro');
const { resolveAccount, markAccountUsed, hasUnusedAccount } = require('./accounts');
const { seedAccount } = require('./seed-account');
const { watchFeatureFlags, reportFeatureFlags } = require('./feature-flags');

function loadData() {
  const arg = process.argv.find((a) => a.startsWith('--data='));
  const dataPath = arg ? arg.split('=')[1] : path.join(__dirname, 'test-data.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function selectDropdown(page, buttonName, optionName) {
  await page.getByRole('button', { name: buttonName }).click();

  // mfe-shared-components/SelectDropdown renders the open list as
  // <li role="option"> inside <ul role="listbox">, AND a permanently-mounted
  // hidden native <select> mirror (z-index: -1) whose <option> children carry
  // the same role. getByRole('option') therefore matches two elements and
  // strict mode refuses to pick one. Target the visible list item.
  //
  // Anchored regex rather than hasText's substring match, so "None" cannot also
  // hit "None of the above"; escaped because option labels include values like
  // "$5,000" where $ is a regex metacharacter.
  await page.locator('li[role="option"]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(optionName)}\\s*$`) })
    .first()
    .click();
}

/**
 * Logs in as a pre-seeded borrower instead of creating an account.
 *
 * /create-account is the ONLY path covered by the Cloudflare rule
 * "WEB-ATTACK - Challenge Account Creation" (managed_challenge on go-dev,
 * go-stage and go). Playwright cannot pass that challenge: it launches a fresh
 * profile with no cf_clearance cookie and advertises automation via
 * navigator.webdriver, so the challenge escalates to the interactive checkbox
 * and loops until the navigation times out. Being on VPN does not exempt it —
 * the challenge rule is ordered ahead of the VPN allowlist.
 *
 * /login is not matched by that rule, so this path runs clean.
 */
async function loginExistingAccount(page, data, account) {
  await page.goto(`${data.environment.baseUrl}/login`);

  // /login opens on the PASSWORDLESS step (OTPLogin/LoginPage.js defaults to
  // useState(STEPS.OTP)), which offers an email/mobile field and a one-time
  // code. The email+password form is a STEP CHANGE on the same URL, not a
  // separate route, reached by the "Login with Password" button. The URL never
  // changes, which is why this looked like the page simply wasn't advancing.
  //
  // Conditional rather than unconditional: whether the OTP step renders at all
  // depends on feature flags, and with them off /login shows the password form
  // directly and this button never exists.
  const switchToPassword = page.getByRole('button', { name: /log\s*in with password/i });
  if (await switchToPassword.count()) {
    await switchToPassword.first().click();
  }

  // Both fields render through mfe-shared-components/FormInput -> matter's
  // Input. The email field resolves by accessible name, same as every other
  // field this script drives. The password field does NOT: input[type=password]
  // has no implicit ARIA role, so getByRole('textbox') never matches it, and
  // whether FormInput's `id` reaches the DOM depends on matter internals. Match
  // on the type attribute instead — that is true regardless.
  const emailField = page.getByRole('textbox', { name: 'Email Address' });
  await emailField.waitFor({ timeout: 20000 });
  await emailField.fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);

  // The submit button is disabled until react-hook-form marks the form valid,
  // so clicking immediately after fill() can be a no-op.
  const submit = page.getByRole('button', { name: 'Log In' });
  await waitForEnabled(submit, 15000);
  await submit.click();

  // apply-web routes through /apply/route/borrower to the first INCOMPLETE step,
  // which is not necessarily loan-details: an application that already carries a
  // Requested Loan Amount (cf131) resumes at about-you instead. Accept any apply
  // step and let walkApplySteps() continue from wherever we land.
  try {
    await settleOnApplyStep(page);
  } catch (err) {
    // Say what actually happened rather than just timing out on a regex.
    const shot = `login-failure-${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const alertText = await page.getByRole('alert').first().textContent().catch(() => null);
    throw new Error(
      `Login did not reach the apply funnel.\n` +
      `  landed on : ${page.url()}\n` +
      `  page alert: ${alertText ? alertText.trim() : '(none)'}\n` +
      `  screenshot: ${shot}\n` +
      `  If the alert mentions matching records, the credentials are wrong. If the URL\n` +
      `  is still /login with no alert, the form never submitted — check whether the\n` +
      `  "Login with Password" step switch actually rendered the email+password form.`
    );
  }
  console.log(`Logged in as ${account.email} — resumed application ${applicationIdFromUrl(page.url())} at ${stepNameFromUrl(page.url())}`);
}

/**
 * The apply section, in order. apply-web resumes a returning borrower at the
 * first INCOMPLETE step (RouteBorrower), so the entry point depends on how far
 * that application already got — not on its sub-status. Driving a fixed
 * sequence breaks the moment an application is partly filled; drive whatever
 * step is actually on screen instead.
 */
const APPLY_STEPS = [
  { name: 'loan-details', re: /\/apply\/loan-details\//, run: (p, d) => fillLoanDetails(p, d) },
  { name: 'about-you', re: /\/apply\/about-you\//, run: (p, d) => fillAboutYou(p, d) },
  { name: 'contact-details', re: /\/apply\/contact-details\//, run: (p, d) => fillContactDetails(p, d) },
  { name: 'financial-details', re: /\/apply\/financial-details\//, run: (p, d) => fillFinancialDetails(p, d) },
  { name: 'application-summary', re: /\/apply\/application-summary\//, run: (p) => confirmApplicationSummary(p) },
];

// /apply/route/borrower and /apply/route/application/:id are TRANSIENT
// redirectors, not steps. Matching them as "we have arrived" reads the URL
// before the router has settled: the application id is not in it yet, and no
// step matches, so the walker would exit having done nothing.
const APPLY_ROUTING_RE = /\/apply\/route\//;

/** Resolves once the router has settled on a real destination. */
async function settleOnApplyStep(page, timeout = 45000) {
  await page.waitForURL((u) => {
    const url = String(u);
    if (APPLY_ROUTING_RE.test(url)) return false;
    return APPLY_STEPS.some((x) => x.re.test(url))
      || /\/apply\/application-selection/.test(url)
      || /\/offer\//.test(url)
      || /\/verify\//.test(url);
  }, { timeout });
}

function stepNameFromUrl(url) {
  const step = APPLY_STEPS.find((x) => x.re.test(String(url)));
  if (step) return step.name;
  const m = String(url).match(/\/apply\/([^/?#]+)/);
  return m ? m[1] : 'an unrecognised page';
}

async function walkApplySteps(page, data) {
  // + 2 so a legitimate re-render of the same step cannot spin forever.
  for (let guard = 0; guard < APPLY_STEPS.length + 3; guard += 1) {
    if (APPLY_ROUTING_RE.test(page.url())) {
      await settleOnApplyStep(page);
    }
    const url = page.url();
    const step = APPLY_STEPS.find((x) => x.re.test(url));
    if (!step) {
      if (/\/apply\/application-selection/.test(url)) {
        throw new Error(
          'Landed on /apply/application-selection — this borrower has more than one ' +
          'application (ENABLE_APPLICATION_SELECTION is ON). Accounts are single-use; ' +
          'use a fresh one.'
        );
      }
      return; // left the apply section — offers, decline, etc.
    }
    console.log(`  step: ${step.name}`);
    await step.run(page, data);
    await page.waitForURL((u) => !step.re.test(String(u)), { timeout: 30000 });
  }
  throw new Error(`Stuck in the apply section at ${page.url()} — step did not advance.`);
}

async function fillLoanDetails(page, data) {
  await page.getByRole('textbox', { name: 'Desired Loan Amount' }).fill(String(data.loanDetails.desiredLoanAmount));
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function fillAboutYou(page, data) {
  const d = data.aboutYou;
  await page.getByRole('textbox', { name: 'First Name' }).fill(d.firstName);
  await page.getByRole('textbox', { name: 'Last Name' }).fill(d.lastName);
  if (d.suffix && d.suffix !== 'None') {
    await selectDropdown(page, 'None', d.suffix);
  }
  await page.getByRole('textbox', { name: 'Date Of Birth' }).fill(d.dateOfBirth);
  await selectDropdown(page, 'US citizenship status', d.citizenshipStatus);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function fillContactDetails(page, data) {
  const d = data.contactDetails;
  await page.getByRole('textbox', { name: 'Street Address' }).fill(d.streetAddress);
  if (d.aptSuiteOther) {
    await page.getByRole('textbox', { name: 'Apt/Suite/Other' }).fill(d.aptSuiteOther);
  }
  await page.getByRole('textbox', { name: 'City' }).fill(d.city);
  await selectDropdown(page, 'Choose state', d.state);
  await page.getByRole('textbox', { name: 'Zip Code' }).fill(d.zipCode);
  await page.getByRole('textbox', { name: 'Phone Number' }).fill(d.phoneNumber);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function fillFinancialDetails(page, data) {
  const d = data.financialDetails;
  await page.getByRole('textbox', { name: 'Total Annual Income' }).fill(String(d.totalAnnualIncome));
  await selectDropdown(page, 'Select income type', d.incomeType);
  await page.getByRole('textbox', { name: 'Housing Payment' }).fill(String(d.housingPayment));
  await selectDropdown(page, 'Do you rent or pay a mortgage?', d.housingPaymentType);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function confirmApplicationSummary(page) {
  await page.getByRole('button', { name: 'Agree, Verify and Complete' }).click();
  await page.waitForURL(/\/offer\/offers\//, { timeout: 60000 });
}

// The offers page polls for the decision rather than blocking on it: see
// offers-mfe/src/hooks/usePollingApplicationById.js, MAX_OFFER_ATTEMPTS (24) x
// POLLING_INTERVAL_IN_SECONDS (5) = 120 SECONDS. Offer generation genuinely
// takes that long sometimes.
//
// Waiting less than the page's own budget reports a failure the app had not
// reached yet. Reloading is worse than waiting: polling state lives in a module
// -level object whose `attempts` resets to 1 on mount, so a reload throws away
// the progress made so far and starts the 120s again.
const OFFERS_POLL_BUDGET_MS = 24 * 5 * 1000;
const OFFERS_POLL_TIMEOUT_MS = OFFERS_POLL_BUDGET_MS + 30000; // + margin for render

/** Dumps what is actually on the offers page, so a miss is diagnosable in one round. */
async function reportOffersPageState(page) {
  const shot = `offers-failure-${Date.now()}.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const texts = async (sel, cap) => {
    const all = await page.locator(sel).allTextContents().catch(() => []);
    return all.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, cap);
  };
  console.log('--- offers page state ---');
  console.log(`  url        : ${page.url()}`);
  console.log(`  headings   : ${JSON.stringify(await texts('h1, h2, h3', 8))}`);
  console.log(`  buttons    : ${JSON.stringify(await texts('button', 12))}`);
  console.log(`  radios     : ${await page.getByRole('radio').count()}`);
  console.log(`  listboxes  : ${await page.locator('[aria-haspopup="listbox"]').count()}`);
  console.log(`  screenshot : ${shot}`);
  console.log('-------------------------');
}

async function selectOffer(page, data) {
  const cfg = data.offerSelection;

  // The offers page is the "new" (AmountSlider) implementation. It sits behind
  // the LaunchDarkly flag OFFER_PAGE_VERSION (offers-mfe/src/pages/Offers/
  // index.js); dev and stage are both 100% rolled out to "new" and that is the
  // permanent direction, so the original page is not handled here. It replaced
  // the original "$5,000" dropdown button with an AmountSlider. Its desktop control is still a SelectDropdown, but the trigger
  // is a role="button" DIV whose accessible name is not reliably a bare currency
  // string — which is why matching on /^\$[\d,]+$/ timed out. Find it
  // structurally by aria-haspopup, and treat it as optional: the slider defaults
  // to the requested loan amount, so usually there is nothing to change.
  if (cfg.loanAmount) {
    const amountTrigger = page.locator('[role="button"][aria-haspopup="listbox"]').first();
    if (await amountTrigger.count()) {
      const current = ((await amountTrigger.textContent().catch(() => '')) || '').trim();
      if (!current.includes(cfg.loanAmount)) {
        await amountTrigger.click();
        await page.locator('li[role="option"]')
          .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(cfg.loanAmount)}\\s*$`) })
          .first()
          .click();
      }
    } else {
      console.log(`  No amount selector on this offers page — keeping the default (wanted ${cfg.loanAmount}).`);
    }
  }

  // The autopay toggle is itself flag-gated (isAutopayDiscountEnabled), so it
  // may legitimately not render.
  const autopayToggle = page.getByRole('switch', { name: 'Toggle autopay discount' });
  if (await autopayToggle.count()) {
    const isChecked = (await autopayToggle.getAttribute('aria-checked')) === 'true';
    if (Boolean(cfg.applyAutopayDiscount) !== isChecked) {
      await autopayToggle.click();
    }
  } else if (cfg.applyAutopayDiscount) {
    console.log('  Autopay discount toggle is not rendered — skipping.');
  }

  // OfferCardNew carries a real radio; the retired original OfferCard does not,
  // so radios are also the signal that offers actually rendered.
  //
  // The offers list is populated asynchronously after underwriting-srv finishes
  // generating offers, which can land AFTER this page first paints. If nothing
  // has rendered, reload once before giving up: a page that painted too early
  // will not necessarily poll itself into the right state.
  const offerRadios = page.getByRole('radio');
  try {
    await offerRadios.first().waitFor({ timeout: OFFERS_POLL_TIMEOUT_MS });
  } catch {
    await reportOffersPageState(page);
    throw new Error(
      `Offers never rendered within ${OFFERS_POLL_TIMEOUT_MS / 1000}s, which is past the ` +
      "page's own polling budget — so it gave up too, and this is not a wait that is " +
      'too short. See the dump above and the screenshot: if LoanPro has offers for ' +
      'this application but the page shows none, the mismatch is in the apply-bff ' +
      'fetch, not in these selectors.'
    );
  }
  const count = await offerRadios.count();
  const index = cfg.offerIndex ?? 0;
  if (index >= count) {
    throw new Error(`offerSelection.offerIndex is ${index} but only ${count} offer(s) rendered.`);
  }
  await offerRadios.nth(index).click();

  await page.getByRole('button', { name: 'Select this offer' }).click();
  await page.waitForURL(/\/verify\/ssn\//, { timeout: 20000 });
}

async function verifyIdentity(page, data) {
  const d = data.verifyIdentity;
  await page.getByRole('textbox', { name: /Social Security Number/ }).fill(d.ssnLast4);
  await page.getByRole('combobox', { name: 'Occupation' }).fill(d.occupation);
  await page.getByRole('option', { name: d.occupation, exact: false }).first().click().catch(() => {});
  await page.getByRole('textbox', { name: 'Employer Name' }).fill(d.employerName);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function waitForEnabled(locator, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await locator.isEnabled()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for "${await locator.textContent()}" to become enabled`);
}

async function handleSmsOtp(page, data) {
  // The SSN page polls the same way the offers page does (SsnPage.js uses
  // usePollingApplicationById), so the hop off it is bounded by that 120s
  // budget, not by a page load. And the OTP step is itself conditional
  // (ENABLE_SMS_OTP_VERIFICATION) — when it is off the funnel goes straight to
  // the checklist, so accept either destination rather than only the OTP one.
  await page.waitForURL(
    (u) => /\/verify\/(sms-otp-verification|check-list)\//.test(String(u)),
    { timeout: OFFERS_POLL_TIMEOUT_MS },
  );
  if (/\/verify\/check-list\//.test(page.url())) {
    console.log('  SMS OTP step was skipped — already at the checklist.');
    return;
  }
  await page.getByRole('button', { name: 'Send Code' }).click();

  if (data.otp?.mode === 'skip') {
    // The app has no code-level OTP bypass, but resending twice (hitting the
    // in-app retry limit) surfaces a "Still waiting on your code?" modal with
    // a Skip button that advances the funnel without a real code.
    const resendButton = page.getByRole('button', { name: 'Resend code' });
    await resendButton.waitFor({ timeout: 20000 });
    for (let i = 0; i < 2; i += 1) {
      await waitForEnabled(resendButton);
      await resendButton.click();
    }
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.waitForURL(/\/verify\/check-list\//, { timeout: 20000 });
    return;
  }

  const code = await prompt('Enter the SMS OTP code sent to the phone on the application: ');
  await page.getByRole('textbox', { name: /code/i }).fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function uploadDocuments(page, data) {
  await page.waitForURL(/\/verify\/check-list\//, { timeout: 20000 });

  // Document upload is a BRANCH, not a step. When identity and income verify
  // cleanly, LoanPro requests no documents, apply-web's `noRequiredDocUpload`
  // goes true and the checklist auto-passes with nothing to upload. Measured in
  // orig-sandbox: 55 of 66 applications that reached Originated last month
  // uploaded no documents at all. Detect the branch instead of assuming it.
  const fileInputs = page.locator('input[type="file"]');
  await page.waitForTimeout(3000); // let the checklist finish rendering
  const inputCount = await fileInputs.count();
  if (inputCount === 0) {
    console.log('No documents requested — verification auto-passed. Skipping the upload step.');
    return false;
  }

  const docs = data.documentUpload;
  if (!docs) {
    console.log(`${inputCount} document(s) requested but no documentUpload paths configured — leaving the checklist unfilled.`);
    return false;
  }

  // The file inputs are visually hidden (react-dropzone style), but
  // Playwright's setInputFiles works on hidden inputs directly — no need to
  // force them visible the way the manual chrome-devtools-mcp walkthrough did.
  const paths = [docs.ssnCardPath, docs.addressVerificationPath, docs.govIdPath];
  for (let i = 0; i < Math.min(inputCount, paths.length); i += 1) {
    await fileInputs.nth(i).setInputFiles(paths[i]);
  }

  // apply-bff runs an automated image-quality check per document ("photo
  // isn't clear enough to read" for placeholder images) with a "Keep File"
  // override button. Click through any that appear.
  const keepFileButtons = page.getByRole('button', { name: 'Keep File' });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && (await keepFileButtons.count()) > 0) {
    await keepFileButtons.first().click();
    await page.waitForTimeout(1000);
  }

  const doneButton = page.getByRole('button', { name: "I'm Done Uploading" });
  await waitForEnabled(doneButton, 30000);
  await doneButton.click();
  return true;
}

/**
 * An application whose documents were uploaded is stuck at Underwriting (64):
 * placeholder images land as Ocrolus "Invalid document" (status 46), which
 * Rule 259 treats as a permanent blocker. Clear the blockers in LoanPro so the
 * run can carry on into the rest of the funnel.
 *
 * Only runs when documents were actually uploaded AND loanpro.enabled is set.
 */
async function advanceThroughUnderwriting(page, data) {
  if (!data.loanpro?.enabled) {
    console.log('loanpro.enabled is false — leaving the application in the underwriting queue.');
    return;
  }

  const appId = applicationIdFromUrl(page.url());
  if (!appId) {
    console.log(`Could not read an application id from ${page.url()} — skipping the LoanPro step.`);
    return;
  }

  console.log(`Application ${appId}: clearing underwriting blockers in LoanPro...`);
  const api = await loanproClient();
  try {
    await waitForSubStatus(api, appId, SUBSTATUS.UNDERWRITING, 60000);
    const { payloads } = await advancePastUnderwriting(api, appId);
    console.log(`  applied ${payloads.length} update(s), waiting for Rule 259...`);
    await waitForSubStatus(api, appId, SUBSTATUS.UNDERWRITING_COMPLETE, 45000);
    console.log('  reached Underwriting Complete (132).');
    await page.reload(); // apply-web re-reads loanSubStatus on load
  } finally {
    await api.dispose();
  }
}

async function run() {
  const data = loadData();
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Attach before the first navigation — the LD client evaluates on init.
  const flags = watchFeatureFlags(page);

  // "auto" seeds a borrower through the LoanPro API and so needs a token. Rather
  // than dying on a config file that ships in the repo and will keep overwriting
  // local preferences, fall back to the pooled accounts when one is available.
  let mode = data.account?.mode || 'auto';
  if (mode === 'auto' && !process.env.LOANPRO_TOKEN) {
    if (hasUnusedAccount()) {
      console.log('LOANPRO_TOKEN is not set — using the accounts.json pool instead of seeding.');
      mode = 'login';
    } else {
      throw new Error(
        'account.mode is "auto", which seeds a borrower via the LoanPro API, but ' +
        'LOANPRO_TOKEN is not set and accounts.json has no unused entry.\n' +
        '  Either: cp .env.example .env and add LOANPRO_TOKEN (see README),\n' +
        '  or:     drop a seeded accounts.json in the repo root.'
      );
    }
  }

  if (mode === 'auto') {
    console.log('Seeding a fresh borrower...');
    await loginExistingAccount(page, data, await seedAccount(data));
  } else if (mode === 'login') {
    const account = resolveAccount(data);
    await loginExistingAccount(page, data, account);
    // Only now is the application actually in play. A run that died before this
    // point left it untouched and the account is still good.
    markAccountUsed(account.email);
  } else {
    // Cloudflare challenges this path and Playwright cannot pass it — see
    // loginExistingAccount(). Kept for testing signup itself, from a browser
    // profile that already holds a cf_clearance cookie.
    await page.goto(`${data.environment.baseUrl}/create-account`);
    await page.getByRole('textbox', { name: 'Email Address' }).fill(data.account.email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/apply\/loan-details\//, { timeout: 20000 });
  }

  reportFeatureFlags(flags);

  await walkApplySteps(page, data);

  await page.waitForURL(/\/offer\/offers\//, { timeout: 30000 });
  await selectOffer(page, data);
  await verifyIdentity(page, data);
  await handleSmsOtp(page, data);
  const uploaded = await uploadDocuments(page, data);

  if (uploaded) {
    await advanceThroughUnderwriting(page, data);
  }

  console.log('Reached:', page.url());
  console.log('Steps past Underwriting Complete (Stacker Check, Pre-Funding, TIL/esign,');
  console.log('Originated) are not yet mapped. To find the next gate, run:');
  console.log('  automation-rules-decoder.py --status <substatus> --database orig-sandbox');

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
