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
  const docs = data.documentUpload;
  if (!docs) {
    console.log('No documentUpload paths configured in test-data.json — leaving the checklist unfilled.');
    return;
  }

  // The 3 file inputs are visually hidden (react-dropzone style), but
  // Playwright's setInputFiles works on hidden inputs directly — no need to
  // force them visible the way the manual chrome-devtools-mcp walkthrough did.
  const fileInputs = page.locator('input[type="file"]');
  await fileInputs.nth(0).setInputFiles(docs.ssnCardPath);
  await fileInputs.nth(1).setInputFiles(docs.addressVerificationPath);
  await fileInputs.nth(2).setInputFiles(docs.govIdPath);

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
}

async function run() {
  const data = loadData();
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto(`${data.environment.baseUrl}/create-account`);
  await page.getByRole('textbox', { name: 'Email Address' }).fill(data.account.email);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.waitForURL(/\/apply\/loan-details\//, { timeout: 20000 });
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
  await uploadDocuments(page, data);

  console.log('Reached:', page.url());
  console.log('Application now sits in backend "Document Review in Progress" — an async');
  console.log('apply-bff queue with no further frontend-controllable step. Steps past this');
  console.log('(final approval, bank linking, funding) are not yet mapped.');

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
