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
const { randomUUID } = require('crypto');
const { request } = require('playwright');

const LOANPRO_BASE = 'https://happymoney.simnang.com/api/public/api/1';

// The identifiers the real funnel assigns at signup. A bare application created
// through the API has none of them, and WITHOUT THEM THE APPLICATION CANNOT BE
// ALLOCATED -- see stampFunnelIdentifiers().
const CUSTOM_FIELD = {
  APPLICATION_ID: 130,
  APPLICATION_GUID: 659,
  PAYOFF_LOAN_ID: 696,
};
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

  await stampFunnelIdentifiers(api, loanId);

  return { customerId, applicationId: String(loanId) };
}

/**
 * Writes the three identifiers the real funnel assigns at signup and an
 * API-created application does not have.
 *
 * WITHOUT THESE THE APPLICATION REACHES Approved (95) AND STOPS THERE, FOREVER.
 * The chain, measured 2026-09-10 across five applications:
 *
 *   underwriting-srv's PartnerAllocationEventConsumer fires on approval and
 *   calls allocationEngineClient.assignInvestor(applicationId). The engine looks
 *   the application up, finds no GUID, and returns a response whose leadGuid is
 *   null -- which fails Avro deserialization inside AllocationEngineClient:
 *
 *     Call assignInvestor - Allocation Engine failed:
 *       Avro Error ... Field leadGuid type:STRING pos:1 does not accept null values
 *
 *   That throws before getCapitalPartner() is ever reached, so Capital Partner
 *   (cf231) is never written, the application never advances to Approved
 *   Received (124) or Allocated (123), and getFundRoute -- which requires
 *   ALLOCATED && capitalPartner -- returns null, making every page past the
 *   verification checklist unreachable in the browser.
 *
 * Applications 69951, 69953 and 69954 all stalled exactly there. Application
 * 70089 was given these three fields before its run and allocated to FTCU
 * within seconds of Approved. The only variable changed was this stamp.
 *
 * leadGuid IS the application guid: on a manually-walked application (70020)
 * the engine returned leadGuid 3e0b7bd0-f678-4666-a0fe-c9ff9e85e358 and cf130 /
 * cf659 both held that same value, with cf696 = HMc9ff9e85e358 -- 'HM' plus the
 * guid's last segment, which is the derivation reproduced here.
 */
async function stampFunnelIdentifiers(api, loanId) {
  const guid = randomUUID();
  const payoffLoanId = `HM${guid.split('-').pop()}`;

  const res = await api.put(`${LOANPRO_BASE}/odata.svc/Loans(${loanId})`, {
    data: {
      __update: true,
      __id: loanId,
      LoanSettings: {
        __update: true,
        customFieldValues: {
          results: [
            { customFieldId: CUSTOM_FIELD.APPLICATION_GUID, customFieldValue: guid },
            { customFieldId: CUSTOM_FIELD.APPLICATION_ID, customFieldValue: guid },
            { customFieldId: CUSTOM_FIELD.PAYOFF_LOAN_ID, customFieldValue: payoffLoanId },
          ],
        },
      },
    },
  });
  if (!res.ok()) {
    throw new Error(
      `funnel identifier stamp failed (${res.status()}) on application ${loanId}: ` +
      `${(await res.text()).slice(0, 300)}\n` +
      '  Without these the application cannot be allocated and will stop at Approved.'
    );
  }
  console.log(`  guid ${guid} · payoffLoanId ${payoffLoanId}`);
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
