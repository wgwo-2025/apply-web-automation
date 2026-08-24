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
const { resolveAccount } = require('./accounts');

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

async function selectDropdown(page, buttonName, optionName) {
  await page.getByRole('button', { name: buttonName }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
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
  await page.getByRole('textbox', { name: 'Email Address' }).fill(account.email);
  // The password field is type="password", which has no implicit textbox role.
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: 'Log In' }).click();

  // A seeded application sits at sub-status 60 (Started), so apply-web routes
  // through /apply/route/borrower and lands on loan-details — the same place
  // account creation would have left us.
  await page.waitForURL(/\/apply\/loan-details\//, { timeout: 30000 });
  console.log(`Logged in as ${account.email} — resumed application ${applicationIdFromUrl(page.url())}`);
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
  await page.waitForURL(/\/offer\/offers\//, { timeout: 20000 });
}

async function selectOffer(page, data) {
  const cfg = data.offerSelection;

  const currentAmount = await page.getByRole('button', { name: /^\$[\d,]+$/ }).first().textContent();
  if (cfg.loanAmount && currentAmount.trim() !== cfg.loanAmount) {
    await selectDropdown(page, currentAmount.trim(), cfg.loanAmount);
  }

  const autopayToggle = page.getByRole('switch', { name: 'Toggle autopay discount' });
  const isChecked = (await autopayToggle.getAttribute('aria-checked')) === 'true';
  if (Boolean(cfg.applyAutopayDiscount) !== isChecked) {
    await autopayToggle.click();
  }

  const offerRadios = page.getByRole('radio');
  await offerRadios.nth(cfg.offerIndex ?? 0).click();
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
  await page.waitForURL(/\/verify\/sms-otp-verification\//, { timeout: 20000 });
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

  if ((data.account?.mode || 'create') === 'login') {
    await loginExistingAccount(page, data, resolveAccount(data));
  } else {
    // Cloudflare challenges this path and Playwright cannot pass it — see
    // loginExistingAccount(). Kept for testing signup itself, from a browser
    // profile that already holds a cf_clearance cookie.
    await page.goto(`${data.environment.baseUrl}/create-account`);
    await page.getByRole('textbox', { name: 'Email Address' }).fill(data.account.email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/apply\/loan-details\//, { timeout: 20000 });
  }

  await fillLoanDetails(page, data);

  await page.waitForURL(/\/apply\/about-you\//, { timeout: 20000 });
  await fillAboutYou(page, data);

  await page.waitForURL(/\/apply\/contact-details\//, { timeout: 20000 });
  await fillContactDetails(page, data);

  await page.waitForURL(/\/apply\/financial-details\//, { timeout: 20000 });
  await fillFinancialDetails(page, data);

  await page.waitForURL(/\/apply\/application-summary\//, { timeout: 20000 });
  await confirmApplicationSummary(page);

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
