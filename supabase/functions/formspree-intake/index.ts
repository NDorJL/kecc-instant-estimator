// KECC Formspree → Supabase Lead Intake
// SUPABASE_URL is auto-injected by the runtime; only service key needs to be set manually.
const SUPABASE_URL = `https://kskplucbdojagvscvlce.supabase.co`;
const SERVICE_KEY  = Deno.env.get('KECC_SERVICE_KEY')!;
const headers = (extra = {}) => ({ 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, ...extra });
async function query(path: string, method: string, body?: object) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: headers({ Prefer: method === 'POST' ? 'return=representation' : '' }), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; } catch { return { ok: res.ok, status: res.status, data: text }; }
}
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let payload: Record<string, string>;
  try { payload = await req.json(); } catch { return new Response('Bad Request', { status: 400 }); }
  const name = (payload['Name'] || '').trim();
  const email = (payload['Email'] || '').trim().toLowerCase();
  const phone = (payload['Phone'] || '').trim();
  const address = (payload['Address'] || '').trim();
  const service = (payload['Service'] || '').trim();
  const leadType = (payload['Lead Type'] || '').trim();
  const serviceMode = (payload['Service Mode'] || '').trim();
  const propType = (payload['Property Type'] || 'residential').trim().toLowerCase();
  const estimateStr = (payload['Estimate Range'] || '').trim();
  const propDetails = (payload['Property Details'] || '').trim();
  const jobNotes = (payload['Job Notes'] || '').trim();
  const hearAbout = (payload['How Did You Hear'] || '').trim();
  const customReq = (payload['Custom Request'] || '').trim();
  const bundleSvcs = (payload['Bundle Services Selected'] || '').trim();
  if (!name || !email) return new Response(JSON.stringify({ error: 'Missing name or email' }), { status: 422 });
  let estimatedValue: number | null = null;
  const nums = estimateStr.replace(/[^0-9\-\u2013]/g, ' ').trim().split(/[\s\u2013\-]+/).filter(Boolean);
  if (nums.length === 2) estimatedValue = Math.round((Number(nums[0]) + Number(nums[1])) / 2);
  else if (nums.length === 1 && Number(nums[0]) > 0) estimatedValue = Number(nums[0]);
  const notesParts: string[] = [];
  if (address) notesParts.push(`Address: ${address}`);
  if (serviceMode) notesParts.push(`Mode: ${serviceMode}`);
  if (leadType) notesParts.push(`Lead Type: ${leadType}`);
  if (propDetails && propDetails !== '\u2014') notesParts.push(`Property Details: ${propDetails}`);
  if (bundleSvcs) notesParts.push(`Bundle Services: ${bundleSvcs}`);
  if (customReq) notesParts.push(`Custom Request: ${customReq}`);
  if (jobNotes && jobNotes !== '\u2014') notesParts.push(`Job Notes: ${jobNotes}`);
  const leadNotes = notesParts.join('\n');
  let contactId: string | null = null;
  const existing = await query(`contacts?email=eq.${encodeURIComponent(email)}&select=id&limit=1`, 'GET');
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    contactId = existing.data[0].id;
  } else {
    const created = await query('contacts', 'POST', { name, email: email || null, phone: phone || null, type: propType.startsWith('commercial') ? 'commercial' : 'residential', source: hearAbout || 'Instant Estimator', notes: address || null, tags: ['web-lead'], has_left_review: false });
    if (created.ok && Array.isArray(created.data) && created.data.length > 0) contactId = created.data[0].id;
  }
  const leadResult = await query('leads', 'POST', { contact_id: contactId, stage: 'new', source: hearAbout || 'Instant Estimator', service_interest: service || null, estimated_value: estimatedValue, notes: leadNotes || null, photo_stacks: [] });
  if (!leadResult.ok) return new Response(JSON.stringify({ error: 'Lead creation failed', detail: leadResult.data }), { status: 500 });
  const leadId = Array.isArray(leadResult.data) ? leadResult.data[0]?.id : null;
  return new Response(JSON.stringify({ success: true, contactId, leadId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
