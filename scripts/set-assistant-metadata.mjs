// ============================================================
// CREWBOX — SET contractor_id ON A VAPI ASSISTANT
// File: scripts/set-assistant-metadata.mjs
//
// Sets metadata.contractor_id on the "Appointment Receptionist"
// Vapi assistant so the book-appointment route knows which
// contractor a call belongs to.
//
// Usage:
//   node scripts/set-assistant-metadata.mjs <contractor-id>
//
// The Vapi PRIVATE key is read from the VAPI_PRIVATE_KEY
// environment variable if it is set; otherwise you are prompted
// for it (input hidden). It is never read from a file, never
// written anywhere, and never printed.
// ============================================================

const ASSISTANT_ID = '3fe11e1c-01cc-4fd1-8f4f-a8b6f9c974b0';
const VAPI_API = 'https://api.vapi.ai';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Prompt for a secret without echoing it to the terminal
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      return reject(new Error('No VAPI_PRIVATE_KEY set and no interactive terminal to prompt in'));
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      err ? reject(err) : resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled'));   // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); // backspace
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function vapi(key, method, body) {
  const res = await fetch(`${VAPI_API}/assistant/${ASSISTANT_ID}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const detail = data?.message ?? data?.error ?? text.slice(0, 300);
    throw new Error(`Vapi ${method} failed (${res.status}): ${Array.isArray(detail) ? detail.join('; ') : detail}`);
  }
  return data;
}

async function main() {
  const contractorId = process.argv[2];
  if (!contractorId || !UUID_RE.test(contractorId)) {
    throw new Error('Usage: node scripts/set-assistant-metadata.mjs <contractor-id>  (the contractor\'s UUID from Supabase)');
  }

  const key = process.env.VAPI_PRIVATE_KEY?.trim() || await promptHidden('Vapi private key (input hidden): ');
  if (!key) throw new Error('No Vapi private key provided');

  // Read first so existing metadata keys are kept, not overwritten
  const assistant = await vapi(key, 'GET');
  const metadata = { ...(assistant?.metadata || {}), contractor_id: contractorId };

  const updated = await vapi(key, 'PATCH', { metadata });
  if (updated?.metadata?.contractor_id !== contractorId) {
    throw new Error('Vapi accepted the update but did not return the new contractor_id');
  }

  console.log(`Success: "${updated.name}" (${ASSISTANT_ID}) now has metadata.contractor_id = ${contractorId}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
