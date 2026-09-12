/**
 * LoanPro backend helpers for the apply funnel.
 *
 * go-dev writes to LoanPro originations sandbox (tenant 5203310, database
 * 5203310_S) — the same system of record the funnel reads back through
 * los-reader and apply-bff. These helpers exist to unstick a run whose
 * verification deliberately failed; the happy path should not need them.
 *
 * Requires LOANPRO_TOKEN in the environment (see .env.example).
 */
const { request } = require('playwright');

const BASE_URL = 'https://happymoney.simnang.com/api/public/api/1';
const DEFAULT_TENANT = '5203310'; // originations sandbox

// LoanPro sub-statuses this script cares about.
const SUBSTATUS = {
  DOC_UPLOAD: 63,
  UNDERWRITING: 64,
  PRE_FUNDING: 67,
  UNDERWRITING_COMPLETE: 132,
};

// Smart-checklist status_catalog ids.
const CHECKLIST_STATUS = { REQUIRED: 1, SUBMITTED: 2, APPROVED: 3 };

// Rule 259 requires all 9 of these Identity/Income verdicts to equal "2" (Pass).
const IDENTITY_FIELDS = [597, 598, 599, 600, 601, 602, 603, 604, 607];

// Rule 259 refuses to fire while any of these portfolios is active. Only the
// ones a stuck automated run realistically picks up are removed by default.
const BLOCKING_PORTFOLIOS = [103, 107, 200];

const CHECKLIST_ITEM = { APPLICATION_APPROVED: 123 };

const CUSTOM_FIELD = { DOC_UPLOAD_SUBMITTED_TIMESTAMP: 982 };

function loanproClient() {
  const token = process.env.LOANPRO_TOKEN;
  if (!token) {
    throw new Error('LOANPRO_TOKEN is not set — see .env.example');
  }
  // Deliberately no `baseURL`. Playwright resolves request paths with
  // `new URL(path, baseURL)` semantics, so a leading-slash path is treated as
  // root-relative and silently discards the base's `/api/public/api/1` prefix —
  // producing a 409 "No route found". Full URLs via loanUrl() avoid that.
  return request.newContext({
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      'Autopal-Instance-ID': process.env.LOANPRO_TENANT || DEFAULT_TENANT,
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
  });
}

function loanUrl(appId) {
  return `${BASE_URL}/odata.svc/Loans(${appId})`;
}

/**
 * apply-web carries the LoanPro application id in the URL for every funnel
 * route (see apply-web src/packages/apply-mfe/src/route-paths.js), so the
 * page itself is a more reliable source than a search endpoint.
 */
function applicationIdFromUrl(url) {
  const match = String(url).match(/\/(\d{4,})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

async function loadApplication(api, appId) {
  const res = await api.get(loanUrl(appId), {
    params: { $expand: 'ChecklistItemValues,Portfolios,LoanSettings' },
  });
  if (!res.ok()) {
    throw new Error(`LoanPro GET Loans(${appId}) returned ${res.status()}`);
  }
  const d = (await res.json()).d;

  // $expand caps every nested collection at 50 rows with no error and no
  // continuation marker in the obvious place. A doc-heavy application would
  // silently return a partial checklist, so say so rather than half-fixing it.
  const items = d.ChecklistItemValues?.results ?? [];
  if (items.length >= 50) {
    throw new Error(
      `Application ${appId} returned ${items.length} checklist rows — at or past the ` +
      'LoanPro $expand page cap, so the list may be truncated. Page it before trusting this.'
    );
  }

  return {
    settingsId: d.LoanSettings?.id,
    subStatusId: d.LoanSettings?.loanSubStatusId,
    checklistItems: items,
    portfolioIds: (d.Portfolios?.results ?? []).map((p) => p.id),
  };
}

async function getSubStatus(api, appId) {
  const res = await api.get(loanUrl(appId), { params: { $expand: 'LoanSettings' } });
  return (await res.json()).d?.LoanSettings?.loanSubStatusId;
}

/**
 * Waits for an automation rule to move the application. LoanPro rules are
 * real-time but asynchronous — 4-7s is typical.
 */
async function waitForSubStatus(api, appId, target, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await getSubStatus(api, appId);
    if (last === target) return last;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    `Application ${appId} never reached sub-status ${target} (last seen ${last}). ` +
    'Diagnose with: automation-rules-decoder.py <ruleId> --loan ' + appId + ' --database orig-sandbox'
  );
}

/**
 * Clears every Rule 259 blocker so an application sitting at Underwriting (64)
 * advances to Underwriting Complete (132).
 *
 * Rule 259 "Application - Underwriting Complete & Fraud Check Requested
 * portfolio" is the only enabled rule off sub-status 64. It needs, among
 * conditions the funnel already satisfies:
 *   - no checklist item at Required / Submitted / any Rejected-* status
 *   - checklist item 123 "Application Approved" checked
 *   - all 9 Identity/Income verdict fields = "2"
 *   - none of the escalation/review portfolios active
 *
 * Pass { dryRun: true } to get the payloads back without writing.
 */
async function advancePastUnderwriting(api, appId, { dryRun = false } = {}) {
  const app = await loadApplication(api, appId);
  const payloads = [];

  // 1. Clear every non-Approved checklist status. This includes the Ocrolus
  //    rejection codes (44-59) that placeholder document images always earn —
  //    the frontend "Keep File" override does not change the backend verdict.
  const blocking = app.checklistItems.filter(
    (item) => item.statusId != null && item.statusId !== CHECKLIST_STATUS.APPROVED
  );
  if (blocking.length) {
    payloads.push({
      ChecklistItemValues: {
        results: blocking.map((item) => ({
          checklistItemId: item.checklistItemId,
          statusId: CHECKLIST_STATUS.APPROVED,
        })),
      },
    });
  }

  // 2. Check "Application Approved" — normally set by an underwriter.
  payloads.push({
    ChecklistItemValues: {
      results: [{
        checklistItemId: CHECKLIST_ITEM.APPLICATION_APPROVED,
        statusId: CHECKLIST_STATUS.APPROVED,
        checklistItemValue: 1,
      }],
    },
  });

  // 3. All 9 Identity/Income verdicts to Pass.
  payloads.push({
    LoanSettings: {
      __id: app.settingsId,
      __update: true,
      CustomFieldValues: {
        results: IDENTITY_FIELDS.map((customFieldId) => ({
          customFieldId,
          customFieldValue: '2',
        })),
      },
    },
  });

  // 4. Drop the escalation/review portfolios. __destroy is the only removal
  //    verb LoanPro accepts; removing an absent tag returns 409, so skip those.
  for (const portfolioId of BLOCKING_PORTFOLIOS) {
    if (app.portfolioIds.includes(portfolioId)) {
      payloads.push({ Portfolios: { results: [{ __id: portfolioId, __destroy: true }] } });
    }
  }

  if (dryRun) return { app, payloads };

  for (const data of payloads) {
    const res = await api.put(loanUrl(appId), { data });
    if (!res.ok()) {
      throw new Error(`LoanPro PUT failed (${res.status()}): ${await res.text()}`);
    }
  }
  return { app, payloads };
}

/**
 * Writes the Doc Upload Submitted Timestamp (cf982), condition 2 of Rule 297.
 * Clicking "I'm Done Uploading" in the UI does this via apply-bff and is the
 * preferred path — this is the fallback for a run that stalls at sub-status 63.
 *
 * The format is LoanPro's "YYYY-MM-DD HH:MM:SS" with no timezone; apply-bff
 * parses the value back into an OffsetDateTime, so ISO-with-Z risks a read-side
 * parse failure.
 */
async function submitDocUploadTimestamp(api, appId) {
  const { settingsId } = await loadApplication(api, appId);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const res = await api.put(loanUrl(appId), {
    data: {
      LoanSettings: {
        __id: settingsId,
        __update: true,
        CustomFieldValues: {
          results: [{
            customFieldId: CUSTOM_FIELD.DOC_UPLOAD_SUBMITTED_TIMESTAMP,
            customFieldValue: stamp,
          }],
        },
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`LoanPro PUT cf982 failed (${res.status()}): ${await res.text()}`);
  }
  return stamp;
}

module.exports = {
  SUBSTATUS,
  loanproClient,
  applicationIdFromUrl,
  loadApplication,
  getSubStatus,
  waitForSubStatus,
  advancePastUnderwriting,
  submitDocUploadTimestamp,
};
