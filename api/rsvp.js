// Avla Event 7 Haziran 2026 — RSVP backend
// Vercel Serverless Function
//
// Yaptıkları:
// 1. Form data validasyon
// 2. PostHog server-side capture (redundancy — ad blocker bypass)
// 3. HubSpot Contact create (env var: HUBSPOT_TOKEN)
// 4. Meta Conversions API (Lead event — ad blocker bypass, attribution güçlü)
// 5. BigQuery streaming insert (env var: GCP_SA_KEY_JSON — yarın eklenecek)
// 6. Response 200 / hata 4xx-5xx
//
// Env vars (Vercel Settings → Environment Variables):
//   HUBSPOT_TOKEN (Private App token)
//   META_TOKEN (System User access token — keychain "Avla Meta Marketing API Token")
//   META_PIXEL_ID (default: 263544950122179)
//   GCP_SA_KEY_JSON (Service account JSON — escape edilmiş tek satır)

export default async function handler(req, res) {
  // CORS (event.avlarealestate.com'dan POST)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'POST only'});

  let data;
  try {
    data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({error: 'Invalid JSON'});
  }

  // Validate
  if (!data?.email || !data?.fullName || !data?.phone) {
    return res.status(400).json({error: 'email, fullName, phone required'});
  }

  const email = String(data.email).toLowerCase().trim();
  const phone = String(data.phone).replace(/[^0-9+]/g, '');
  const fullName = String(data.fullName).trim();
  const firstName = fullName.split(' ')[0];
  const lastName = fullName.split(' ').slice(1).join(' ');

  const PH_KEY = 'phc_v98y5K8fmzdZsQmyqGAQ92oK73PsaxyVrXSwaYi86Cjp';
  const results = {posthog: null, hubspot: null, meta_capi: null, bigquery: null};

  // 1. PostHog server-side capture
  try {
    const phRes = await fetch('https://eu.i.posthog.com/capture/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        api_key: PH_KEY,
        event: 'rsvp_submitted_server',
        distinct_id: email,
        properties: {
          ...data,
          email,
          phone,
          fullName,
          source: 'event_landing_server',
          ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '',
          user_agent: req.headers['user-agent'] || ''
        },
        timestamp: new Date().toISOString()
      })
    });
    results.posthog = phRes.ok ? 'ok' : `error_${phRes.status}`;
  } catch (e) {
    results.posthog = 'fetch_failed';
  }

  // 2. HubSpot Contact create (env var bekliyor)
  if (process.env.HUBSPOT_TOKEN) {
    try {
      const hsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            email,
            phone,
            firstname: firstName,
            lastname: lastName,
            avla_budget_range: data.budget || '',
            avla_intent_type: data.intent || '',
            avla_source: 'event_landing_2026_06_07',
            avla_first_touch_channel: data.utm_source || '',
            avla_first_touch_campaign: data.utm_campaign || '',
            avla_fbclid: data.fbclid || '',
            avla_gclid: data.gclid || '',
            lifecyclestage: 'lead'
          }
        })
      });
      results.hubspot = hsRes.ok ? 'ok' : `error_${hsRes.status}`;
      if (!hsRes.ok && hsRes.status === 409) {
        // Duplicate — update instead
        const updateRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              phone,
              firstname: firstName,
              lastname: lastName,
              avla_budget_range: data.budget || '',
              avla_intent_type: data.intent || '',
              avla_last_event: 'event_landing_2026_06_07'
            }
          })
        });
        results.hubspot = updateRes.ok ? 'updated' : `update_error_${updateRes.status}`;
      }
    } catch (e) {
      results.hubspot = 'fetch_failed';
    }
  } else {
    results.hubspot = 'skipped_no_token';
  }

  // 4. Meta Conversions API — Lead event (ad blocker bypass, server-side attribution)
  if (process.env.META_TOKEN) {
    try {
      const crypto = await import('node:crypto');
      const sha256 = (s) => crypto.createHash('sha256').update(String(s).toLowerCase().trim()).digest('hex');

      const PIXEL = process.env.META_PIXEL_ID || '263544950122179';
      const eventTime = Math.floor(Date.now() / 1000);
      const eventId = `rsvp_${sha256(email).slice(0, 12)}_${eventTime}`;

      // _fbp ve _fbc cookie'leri (varsa)
      const cookieHeader = req.headers.cookie || '';
      const fbp = cookieHeader.match(/_fbp=([^;]+)/)?.[1] || '';
      const fbc = cookieHeader.match(/_fbc=([^;]+)/)?.[1]
        || (data.fbclid ? `fb.1.${eventTime * 1000}.${data.fbclid}` : '');

      const userData = {
        em: [sha256(email)],
        ph: [sha256(phone.replace(/[^0-9]/g, ''))],
        fn: [sha256(firstName)],
        ln: [sha256(lastName || firstName)],
        client_ip_address: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.headers['x-real-ip'] || '',
        client_user_agent: req.headers['user-agent'] || ''
      };
      if (fbp) userData.fbp = fbp;
      if (fbc) userData.fbc = fbc;

      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${PIXEL}/events?access_token=${process.env.META_TOKEN}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          data: [{
            event_name: 'Lead',
            event_time: eventTime,
            event_id: eventId,  // dedup ile client-side Pixel
            action_source: 'website',
            event_source_url: req.headers.referer || 'https://event.avlarealestate.com',
            user_data: userData,
            custom_data: {
              value: data.budget ? (parseFloat(String(data.budget).replace(/[^0-9.]/g, '')) || 0) : 0,
              currency: 'EUR',
              content_name: 'Avla Event RSVP 7 Haziran 2026',
              content_category: 'event_rsvp',
              lead_event_source: 'event_landing_2026_06_07',
              lead_intent: data.intent || '',
              lead_budget_bucket: data.budget || '',
              utm_source: data.utm_source || '',
              utm_campaign: data.utm_campaign || ''
            }
          }]
        })
      });
      const metaJson = await metaRes.json();
      if (metaRes.ok) {
        results.meta_capi = `ok_received_${metaJson.events_received || 0}_fbtrace_${metaJson.fbtrace_id || 'na'}`;
      } else {
        results.meta_capi = `error_${metaRes.status}_${(metaJson.error?.message || '').slice(0, 80)}`;
      }
    } catch (e) {
      results.meta_capi = `fetch_failed_${(e.message || '').slice(0, 40)}`;
    }
  } else {
    results.meta_capi = 'skipped_no_token';
  }

  // 5. BigQuery insert — env var GCP_SA_KEY_JSON bekliyor
  if (process.env.GCP_SA_KEY_JSON) {
    try {
      const sa = JSON.parse(process.env.GCP_SA_KEY_JSON);
      // Get access token via JWT (basit yöntem için google-auth-library lazım)
      // Şimdilik skip — yarın @google-cloud/bigquery paketi ile yapılır
      results.bigquery = 'todo_use_bq_client';
    } catch (e) {
      results.bigquery = 'sa_parse_failed';
    }
  } else {
    results.bigquery = 'skipped_no_sa';
  }

  return res.status(200).json({
    ok: true,
    received: {email, phone, fullName, budget: data.budget, intent: data.intent},
    integrations: results,
    ts: new Date().toISOString()
  });
}
