/**
 * Seeds a fresh borrower on demand, immediately before a run.
 *
 * Produces a Cognito-CONFIRMED user linked to an empty LoanPro application at
 * sub-status 60 (Started), so logging in at /login lands on
 * /apply/loan-details — exactly where account creation would have left us,
 * without touching /create-account (the only path Cloudflare challenges).
 *
 * Ported from tools/test-user-manager.py in the happy-money-assistant repo,
 * which remains the canonical implementation. If this ever disagrees with that
 * tool, that tool is right.
 *
 * 🔴 ORDER IS LOAD-BEARING AND THE FLOW IS ONE-SHOT.
 *   1. LoanPro customer + application + borrower link
 *   2. apply-bff signup            -> UNCONFIRMED Cognito user
 *   3. apply-bff activate          -> CONFIRMS it. One call per borrower, ever.
 *
 * Signing up before the LoanPro application exists lets the loanpro-cognito-sync
 * Lambda claim the borrower link first; the activate call is then refused and
 * the account is stranded unconfirmed permanently, with no recovery through the
 * public surface (forgot-password and resend-confirmation-code both fail on an
 * unverified email). Emails are single-use, which is why every run mints a new
 * timestamped address rather than reusing one.
 */
const { request } = require('playwright');

const LOANPRO_BASE = 'https://happymoney.simnang.com/api/public/api/1';
const APPLY_BFF = {
  dev: 'https://originations-dev.happymoney.com/services/apply-bff',
  stage: 'https://originations-stage.happymoney.com/services/apply-bff',
};

const SUBSTATUS_STARTED = 60;
const LOAN_STATUS_APPLICATION = 1;

// Pool policy is >=8 chars with lower, upper and a digit. Symbols optional.
const DEFAULT_PASSWORD = process.env.TEST_ACCOUNT_PASSWORD || 'Givemeoffer$123';

// MailAddress is REQUIRED alongside PrimaryAddress — omitting it returns
// HTTP 409 "Mail Address is required".
const ADDRESS = {
  address1: '1035 Hayes St',
  address2: '',
  city: 'San Francisco',
  state: 'geo.state.CA',
  zipcode: '94117',
  country: 'company.country.usa',
};

function loanproHeaders() {
  const token = process.env.LOANPRO_TOKEN;
  if (!token) {
    throw new Error('LOANPRO_TOKEN is not set — see .env.example');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Autopal-Instance-ID': process.env.LOANPRO_TENANT || '5203310',
    'Content-Type': 'application/json',
    Accept: '*/*',
  };
}

async function post(api, url, data, label) {
  const res = await api.post(url, { data });
  if (!res.ok()) throw new Error(`${label} failed (${res.status()}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Every run mints a fresh address — signup emails are single-use. */
function mintEmail(cfg) {
  const prefix = cfg.emailPrefix || 'qa+awa';
  const domain = cfg.emailDomain || 'happymoney.com';
  return `${prefix}-${Date.now()}@${domain}`;
}

async function createLoanProApplication(api, email, cfg) {
  const ts = Date.now();
  const customer = await post(api, `${LOANPRO_BASE}/odata.svc/Customers`, {
    __ignoreWarnings: true,
    firstName: cfg.firstName || 'Test',
    lastName: cfg.lastName || 'Borrower',
    email,
    primaryPhone: '5551234567',
    dob: '1987-01-08',
    ssn: String(ts % 1000000000).padStart(9, '0'),
    customerType: 'customer.type.individual',
    customerIdType: 'customer.idType.ssn',
    generationCode: 0,
    PrimaryAddress: { ...ADDRESS },
    MailAddress: { ...ADDRESS },
  }, 'LoanPro customer create');
  const customerId = customer.d.id;

  const today = new Date();
  const firstPayment = new Date(today.getFullYear(), today.getMonth(), 1);
  firstPayment.setDate(firstPayment.getDate() + 45);
  const iso = (d) => d.toISOString().slice(0, 10);

  const loan = await post(api, `${LOANPRO_BASE}/odata.svc/Loans`, {
    displayId: `[AWA]${ts}`,
    LoanSettings: {
      loanStatusId: LOAN_STATUS_APPLICATION,
      loanSubStatusId: SUBSTATUS_STARTED,
    },
    LoanSetup: {
      active: 1,
      loanAmount: '10000.00',
      loanRate: '12.99',
      loanRateType: 'loan.rateType.annually',
      loanTerm: '36',
      contractDate: iso(today),
      firstPaymentDate: iso(firstPayment),
      loanType: 'loan.type.installment',
      loanClass: 'loan.class.consumer',
      paymentFrequency: 'loan.frequency.monthly',
      calcType: 'loan.calcType.simpleInterest',
      daysInYear: 'loan.daysInYear.actual',
      interestApplication: 'loan.interestApplication.betweenTransactions',
    },
  }, 'LoanPro application create');
  const loanId = loan.d.id;

  // The borrower link uses the deferred-association shape. A plain
  // [{ customerId, isPrimary }] list is SILENTLY DROPPED — 200 returned, zero
  // rows written, borrower-less application — so verify rather than trust the 200.
  const linkRes = await api.put(`${LOANPRO_BASE}/odata.svc/Loans(${loanId})`, {
    data: {
      __update: true,
      __id: loanId,
      Customers: { results: [{ __id: customerId, __setLoanRole: 'loan.customerRole.primary' }] },
    },
  });
  if (!linkRes.ok()) {
    throw new Error(`borrower link failed (${linkRes.status()}) — customer ${customerId}, application ${loanId} were created`);
  }
  const check = await api.get(`${LOANPRO_BASE}/odata.svc/Loans(${loanId})`, {
    params: { $expand: 'Customers' },
  });
  const linked = ((await check.json()).d?.Customers?.results ?? []).some((c) => c.id === customerId);
  if (!linked) {
    throw new Error(`borrower link reported 200 but customer ${customerId} is not on application ${loanId}`);
  }

  return { customerId, applicationId: String(loanId) };
}

async function seedAccount(data) {
  const cfg = data.account || {};
  const envName = cfg.env || 'dev';
  const bff = APPLY_BFF[envName];
  if (!bff) throw new Error(`No apply-bff URL for env '${envName}' (dev, stage only — prod is deliberately absent)`);

  const email = mintEmail(cfg);
  const password = cfg.password || DEFAULT_PASSWORD;
  const api = await request.newContext({ extraHTTPHeaders: loanproHeaders() });

  try {
    // 1. LoanPro first — the activate call needs an application to resolve the
    //    borrower, and signing up first loses the race with the sync Lambda.
    const { customerId, applicationId } = await createLoanProApplication(api, email, cfg);
    console.log(`  application ${applicationId} · customer ${customerId}`);

    // 2. Signup. The user is UNCONFIRMED and cannot log in yet: the pool has no
    //    auto-verification, so Cognito never sends a confirmation code.
    const signup = await api.post(`${bff}/no-auth/auth/signup`, {
      data: { email, password },
      headers: { 'Content-Type': 'application/json' },
    });
    const signupBody = await signup.json();
    if (!signup.ok() || signupBody.errors) {
      throw new Error(`signup failed (${signup.status()}): ${JSON.stringify(signupBody.errors || signupBody).slice(0, 300)}`);
    }
    const subscriberId = (signupBody.data || signupBody).userSub;
    console.log(`  cognito ${subscriberId} (unconfirmed)`);

    // 3. The one-shot confirm.
    const activate = await api.fetch(`${bff}/no-auth/borrowers/update-borrower-subscriber-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { applicationId, subscriberId, email, emailMarketingConsent: false },
    });
    const activateBody = await activate.json().catch(() => ({}));
    if (!activate.ok() || activateBody.errors) {
      throw new Error(
        `activation failed (${activate.status()}): ${JSON.stringify(activateBody.errors || activateBody).slice(0, 300)}\n` +
        '  This endpoint is one-shot and cannot rebind. The account is stranded — ' +
        'the next run will mint a fresh email, so just re-run.'
      );
    }
    console.log(`  activated — ${email} is CONFIRMED and can log in`);

    return { email, password, applicationId, customerId };
  } finally {
    await api.dispose();
  }
}

module.exports = { seedAccount, mintEmail };
