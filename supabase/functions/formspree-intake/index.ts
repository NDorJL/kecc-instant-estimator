// KECC Instant-Estimator → Supabase Lead Intake
//
// Receives form submissions DIRECTLY from the embedded instant-quoter iframe
// (no Formspree middleman). Inserts contact + lead into the CRM's Supabase
// tables and sends an email notification to the owner via Resend.
//
// Name is historical (was "formspree-intake") — kept to avoid breaking the
// existing deployed function URL. Despite the name, this no longer talks to
// Formspree in any form.
//
// Env vars (set via `supabase secrets set …` or the Supabase dashboard):
//   KECC_SERVICE_KEY    Supabase service role key (for DB writes)
//   RESEND_API_KEY      Resend API key (for the notification email)
//   KECC_NOTIFY_EMAIL   Owner's email — receives the "new lead" notification
//   KECC_FROM_EMAIL     (optional) From-address for outgoing email
//                         default: "KECC Leads <noreply@knoxexteriorcare.com>"
//                         Must be a Resend-verified sender domain.
//
// Deploy with --no-verify-jwt so the iframe can POST anonymously:
//   supabase functions deploy formspree-intake --no-verify-jwt

const SUPABASE_URL = `https://kskplucbdojagvscvlce.supabase.co`;
const SERVICE_KEY  = Deno.env.get('KECC_SERVICE_KEY')!;

const RESEND_API_KEY    = Deno.env.get('RESEND_API_KEY');
const KECC_NOTIFY_EMAIL = Deno.env.get('KECC_NOTIFY_EMAIL');
const KECC_FROM_EMAIL   = Deno.env.get('KECC_FROM_EMAIL') ?? 'KECC Leads <noreply@knoxexteriorcare.com>';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
};

const dbHeaders = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  ...extra,
});

async function query(path: string, method: string, body?: object) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: dbHeaders({ Prefer: method === 'POST' ? 'return=representation' : '' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Send the owner-notification email via Resend's HTTP API. No SDK needed.
async function sendNotificationEmail(opts: {
  subject: string
  html: string
}): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn('[formspree-intake] RESEND_API_KEY not set — skipping email');
    return;
  }
  if (!KECC_NOTIFY_EMAIL) {
    console.warn('[formspree-intake] KECC_NOTIFY_EMAIL not set — skipping email');
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: KECC_FROM_EMAIL,
        to: [KECC_NOTIFY_EMAIL],
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[formspree-intake] Resend ${res.status}: ${errText}`);
    }
  } catch (err) {
    console.error('[formspree-intake] Resend fetch failed:', err);
  }
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }

  let payload: Record<string, string>;
  try { payload = await req.json(); }
  catch { return new Response('Bad Request', { status: 400, headers: CORS_HEADERS }); }

  const name        = (payload['Name']         || '').trim();
  const email       = (payload['Email']        || '').trim().toLowerCase();
  const phone       = (payload['Phone']        || '').trim();
  const address     = (payload['Address']      || '').trim();
  const service     = (payload['Service']      || '').trim();
  const leadType    = (payload['Lead Type']    || '').trim();
  const serviceMode = (payload['Service Mode'] || '').trim();
  const propType    = (payload['Property Type'] || 'residential').trim().toLowerCase();
  const estimateStr = (payload['Estimate Range'] || '').trim();
  const propDetails = (payload['Property Details'] || '').trim();
  const jobNotes    = (payload['Job Notes']    || '').trim();
  const hearAbout   = (payload['How Did You Hear'] || '').trim();
  const customReq   = (payload['Custom Request'] || '').trim();
  const bundleSvcs  = (payload['Bundle Services Selected'] || '').trim();

  // Tracking fields (passed in by the iframe — postMessage from parent or
  // URL params from a direct Google Ads click)
  const rawCampaignId = (payload['campaign_id']  || '').trim() || null;
  const utmSource     = (payload['utm_source']   || '').trim() || null;
  const utmMedium     = (payload['utm_medium']   || '').trim() || null;
  const utmCampaign   = (payload['utm_campaign'] || '').trim() || null;
  const gclid         = (payload['gclid']        || '').trim() || null;
  const referrer      = (payload['referrer']     || '').trim() || null;

  if (!name || !email) {
    return new Response(
      JSON.stringify({ error: 'Missing name or email' }),
      { status: 422, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  // ── Estimate parsing ──────────────────────────────────────────────────────
  let estimatedValue: number | null = null;
  const nums = estimateStr.replace(/[^0-9\-–]/g, ' ').trim().split(/[\s–\-]+/).filter(Boolean);
  if (nums.length === 2) estimatedValue = Math.round((Number(nums[0]) + Number(nums[1])) / 2);
  else if (nums.length === 1 && Number(nums[0]) > 0) estimatedValue = Number(nums[0]);

  // ── Compose lead notes (what the user sees in the CRM lead sheet) ─────────
  const notesParts: string[] = [];
  if (address)      notesParts.push(`Address: ${address}`);
  if (serviceMode)  notesParts.push(`Mode: ${serviceMode}`);
  if (leadType)     notesParts.push(`Lead Type: ${leadType}`);
  if (propDetails && propDetails !== '—') notesParts.push(`Property Details: ${propDetails}`);
  if (bundleSvcs)   notesParts.push(`Bundle Services: ${bundleSvcs}`);
  if (customReq)    notesParts.push(`Custom Request: ${customReq}`);
  if (jobNotes && jobNotes !== '—') notesParts.push(`Job Notes: ${jobNotes}`);
  if (utmSource || utmCampaign || gclid) {
    const tParts: string[] = [];
    if (utmSource)   tParts.push(`utm_source=${utmSource}`);
    if (utmMedium)   tParts.push(`utm_medium=${utmMedium}`);
    if (utmCampaign) tParts.push(`utm_campaign=${utmCampaign}`);
    if (gclid)       tParts.push(`gclid=${gclid}`);
    if (referrer)    tParts.push(`referrer=${referrer}`);
    notesParts.push(`Tracking: ${tParts.join(' | ')}`);
  }
  const leadNotes = notesParts.join('\n');

  // ── Resolve campaign ID ───────────────────────────────────────────────────
  // Priority: explicit UUID from iframe → UTM campaign slug lookup → fallback
  const ORGANIC_CAMPAIGN_ID = '9f0ac3ec-2ed2-4dc3-8745-af674dad3ac1';
  let campaignId: string | null = rawCampaignId;
  if (!campaignId && utmCampaign) {
    const camRes = await query(
      `campaigns?utm_campaign=eq.${encodeURIComponent(utmCampaign)}&select=id&limit=1`, 'GET'
    );
    if (camRes.ok && Array.isArray(camRes.data) && camRes.data.length > 0) {
      campaignId = camRes.data[0].id;
    }
  }
  if (!campaignId) campaignId = ORGANIC_CAMPAIGN_ID;

  // Verify the resolved campaign exists. If the fallback UUID hasn't been
  // created as a row in the campaigns table, the lead insert would fail the
  // FK constraint silently. Defensive: re-resolve to null if missing.
  if (campaignId) {
    const verify = await query(`campaigns?id=eq.${campaignId}&select=id&limit=1`, 'GET');
    const exists = verify.ok && Array.isArray(verify.data) && verify.data.length > 0;
    if (!exists) {
      console.warn(`[formspree-intake] campaign_id ${campaignId} not found in campaigns table — falling back to null`);
      campaignId = null;
    }
  }

  // ── Find or create contact ────────────────────────────────────────────────
  let contactId: string | null = null;
  const existing = await query(`contacts?email=eq.${encodeURIComponent(email)}&select=id&limit=1`, 'GET');
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    contactId = existing.data[0].id;
  } else {
    const created = await query('contacts', 'POST', {
      name,
      email: email || null,
      phone: phone || null,
      type: propType.startsWith('commercial') ? 'commercial' : 'residential',
      source: hearAbout || 'Instant Estimator',
      notes: address || null,
      tags: ['web-lead'],
      has_left_review: false,
    });
    if (created.ok && Array.isArray(created.data) && created.data.length > 0) {
      contactId = created.data[0].id;
    }
  }

  // ── Insert lead ───────────────────────────────────────────────────────────
  const leadResult = await query('leads', 'POST', {
    contact_id: contactId,
    stage: 'new',
    source: hearAbout || 'website',
    service_interest: service || null,
    estimated_value: estimatedValue,
    campaign_id: campaignId,
    notes: leadNotes || null,
    photo_stacks: [],
  });
  if (!leadResult.ok) {
    return new Response(
      JSON.stringify({ error: 'Lead creation failed', detail: leadResult.data }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }
  const leadId = Array.isArray(leadResult.data) ? leadResult.data[0]?.id : null;

  // ── Log form_submit event on the matched campaign ─────────────────────────
  if (campaignId) {
    await query('campaign_events', 'POST', {
      campaign_id: campaignId,
      event_type: 'form_submit',
      metadata: { utmSource, gclid, leadId },
    }).catch(() => {/* non-fatal */});
  }

  // ── Send owner notification email (replaces Formspree's email) ────────────
  const detailRows: Array<[string, string]> = [
    ['Service',          service || '—'],
    ['Property Type',    propType === 'commercial' ? 'Commercial' : 'Residential'],
    ['Service Mode',     serviceMode || '—'],
    ['Estimate Range',   estimateStr || '—'],
    ['Property Details', propDetails || '—'],
    ['Job Notes',        jobNotes || '—'],
    ['How Did You Hear', hearAbout || '—'],
    ['Lead Type',        leadType || '—'],
  ];
  if (customReq) detailRows.push(['Custom Request', customReq]);
  if (bundleSvcs) detailRows.push(['Bundle Services', bundleSvcs]);
  if (utmSource || utmCampaign || gclid) {
    detailRows.push(['Attribution',
      [utmSource && `source=${utmSource}`, utmCampaign && `campaign=${utmCampaign}`, gclid && `gclid=${gclid}`]
        .filter(Boolean).join(' · ')]);
  }
  const detailTable = detailRows
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#111827;">${esc(v)}</td></tr>`)
    .join('');

  const subject = `New Lead — ${service || 'Inquiry'} — ${name}`;
  const html = `<!DOCTYPE html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
  <div style="border-bottom:2px solid #16a34a;padding-bottom:12px;margin-bottom:16px;">
    <p style="margin:0;font-size:11px;font-weight:600;color:#16a34a;text-transform:uppercase;letter-spacing:0.08em;">New Lead — Instant Estimator</p>
    <h2 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#111827;">${esc(name)}</h2>
  </div>
  <div style="margin-bottom:20px;">
    <p style="margin:0 0 4px;font-size:13px;color:#374151;"><strong>📞 ${esc(phone || '—')}</strong></p>
    <p style="margin:0 0 4px;font-size:13px;color:#374151;"><strong>✉️ ${esc(email)}</strong></p>
    ${address ? `<p style="margin:0;font-size:13px;color:#374151;"><strong>📍 ${esc(address)}</strong></p>` : ''}
  </div>
  <table style="width:100%;border-collapse:collapse;">${detailTable}</table>
  ${leadId ? `<p style="margin:20px 0 0;font-size:12px;color:#6b7280;">Lead ID: <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;">${esc(leadId)}</code></p>` : ''}
  <p style="margin:16px 0 0;font-size:12px;color:#6b7280;">This lead has been added to your CRM and is awaiting follow-up in the New Lead column.</p>
</div></body></html>`;

  // Fire-and-forget — don't fail the form submission if email fails
  sendNotificationEmail({ subject, html }).catch(() => {/* logged inside */});

  return new Response(
    JSON.stringify({ success: true, contactId, leadId }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
});
