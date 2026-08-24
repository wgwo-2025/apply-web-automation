/**
 * Captures the LaunchDarkly flag values the browser actually evaluated.
 *
 * Every UI surface this script drives is flag-gated, and a flag flipping
 * underneath a run looks exactly like a broken selector — the login OTP step
 * and the offers page both cost a debugging round before anyone thought to
 * check a flag. Logging the evaluated values up front turns that into a glance.
 *
 * Read off the wire rather than out of the page: the LaunchDarkly JS client
 * fetches its flag map over HTTP at init, so intercepting the response needs no
 * API token, no LD credentials and no reach into React context.
 */

// The flags this script's selectors and step sequence actually depend on.
// Anything else LaunchDarkly returns is captured but not printed.
const FLAGS_OF_INTEREST = [
  'OFFER_PAGE_VERSION',          // "new" -> AmountSlider offers page
  'ENABLE_AUTO_PAY_DISCOUNT',    // renders the autopay toggle on offers
  'ENABLE_SMS_OTP',              // login OTP step field label
  'ENABLE_SMS_OTP_VERIFICATION', // the in-funnel SMS OTP step
  'ENABLE_MAGIC_LINK',           // OTP step button wording
  'ENABLE_APPLICATION_SELECTION',// >1 application -> /apply/application-selection
  'DYNAMIC_VERIFICATION',        // doc-upload checklist layout
];

/**
 * Attaches a response listener and returns a live map that fills in as the LD
 * client evaluates. Call before the first navigation.
 */
function watchFeatureFlags(page) {
  const flags = {};

  page.on('response', async (res) => {
    if (!/launchdarkly\.com\/sdk\/eval/.test(res.url())) return;
    let body;
    try {
      body = await res.json();
    } catch {
      return; // streaming pings and non-JSON payloads
    }
    if (!body || typeof body !== 'object') return;
    for (const [key, entry] of Object.entries(body)) {
      // evalx returns { value, version, ... } per flag; older shapes return the
      // bare value. Accept both.
      flags[key] = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    }
  });

  return flags;
}

function reportFeatureFlags(flags) {
  const captured = Object.keys(flags).length;
  if (!captured) {
    console.log('Feature flags: none captured (LaunchDarkly response not seen — flag-dependent UI is unverified this run).');
    return;
  }
  const shown = FLAGS_OF_INTEREST
    .map((name) => `${name}=${name in flags ? JSON.stringify(flags[name]) : '(absent)'}`)
    .join('  ');
  console.log(`Feature flags (${captured} evaluated): ${shown}`);
}

module.exports = { watchFeatureFlags, reportFeatureFlags, FLAGS_OF_INTEREST };
