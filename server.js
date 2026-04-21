require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Token cache (oauth mode) ─────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getBearerToken() {
  const authMode = (process.env.AUTH_MODE || 'apikey').toLowerCase();

  if (authMode === 'apikey') {
    const key = process.env.API_KEY;
    if (!key) throw new Error('API_KEY is not set in .env');
    return key;
  }

  // oauth — client credentials grant
  // Return cached token if still valid (with 30s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 30000) {
    console.log('[auth] Using cached token');
    return cachedToken;
  }

  const tokenUrl     = process.env.TOKEN_URL;
  const clientId     = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const scope        = process.env.TOKEN_SCOPE || '';
  const debug        = process.env.TOKEN_DEBUG === 'true';

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('TOKEN_URL, CLIENT_ID, and CLIENT_SECRET must be set for AUTH_MODE=oauth');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    ...(scope ? { scope } : {}),
  });

  console.log(`[auth] Fetching token from ${tokenUrl}`);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  if (debug) {
    console.log('[auth] Full token response:', JSON.stringify(data, null, 2));
  }

  const token = data.access_token;
  const expiresIn = data.expires_in || 3600;

  if (!token) throw new Error('Token response did not include access_token');

  if (debug) {
    console.log('[auth] token_type:', data.token_type);
    console.log('[auth] token preview:', token.slice(0, 80) + (token.length > 80 ? '...' : ''));
    const parts = token.split('.');
    console.log(`[auth] token parts (dot-separated): ${parts.length} — ${parts.length === 3 ? 'looks like a valid JWT' : 'NOT a standard JWT'}`);
  }

  cachedToken = token;
  tokenExpiresAt = Date.now() + expiresIn * 1000;

  console.log(`[auth] New token fetched, expires in ${expiresIn}s`);
  return token;
}

// Build the auth header value based on .env config
function buildAuthHeader(token) {
  const headerName = process.env.TOKEN_HEADER_NAME || 'Authorization';
  const prefix     = process.env.TOKEN_PREFIX !== undefined ? process.env.TOKEN_PREFIX : 'Bearer';
  const value      = prefix ? `${prefix} ${token}` : token;
  return { name: headerName, value };
}

// ── Config endpoint ──────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    title:          process.env.CHATBOT_TITLE    || 'AI Assistant',
    subtitle:       process.env.CHATBOT_SUBTITLE || 'How can I help you today?',
    primaryColor:   process.env.PRIMARY_COLOR    || '#0066cc',
    secondaryColor: process.env.SECONDARY_COLOR  || '#0052a3',
    authMode:       (process.env.AUTH_MODE || 'apikey').toLowerCase(),
  });
});

// ── Models endpoint ──────────────────────────────────────────────────────────
app.get('/api/models', async (req, res) => {
  const apiBaseUrl = process.env.API_BASE_URL || 'https://api.openai.com/v1';

  try {
    const token = await getBearerToken();
    const { name: headerName, value: headerValue } = buildAuthHeader(token);

    const response = await fetch(`${apiBaseUrl}/models`, {
      headers: { [headerName]: headerValue },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Models API error:', response.status, text);
      return res.status(response.status).json({ error: `Models API returned ${response.status}: ${text}` });
    }

    const data = await response.json();
    const models = (data.data || data.models || [])
      .map(m => m.id || m.name || m)
      .filter(Boolean)
      .sort();

    res.json({ models });

  } catch (err) {
    console.error('Models error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, model } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const apiBaseUrl   = process.env.API_BASE_URL  || 'https://api.openai.com/v1';
  const modelName    = model || 'gpt-4o';
  const systemPrompt = process.env.SYSTEM_PROMPT || 'You are a helpful assistant.';

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  console.log(`[chat] model=${modelName} — "${messages[messages.length - 1]?.content?.slice(0, 60)}..."`);

  try {
    const token = await getBearerToken();
    const { name: headerName, value: headerValue } = buildAuthHeader(token);

    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerName]: headerValue,
      },
      body: JSON.stringify({
        model: modelName,
        messages: fullMessages,
        temperature: 0,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Chat API error:', response.status, text);
      return res.status(response.status).json({ error: `API returned ${response.status}: ${text}` });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const authMode   = (process.env.AUTH_MODE || 'apikey').toLowerCase();
  const headerName = process.env.TOKEN_HEADER_NAME || 'Authorization';
  const prefix     = process.env.TOKEN_PREFIX !== undefined ? process.env.TOKEN_PREFIX : 'Bearer';
  console.log(`\nChatbot demo running on http://localhost:${PORT}`);
  console.log(`  Title:    ${process.env.CHATBOT_TITLE || 'AI Assistant'}`);
  console.log(`  API:      ${process.env.API_BASE_URL  || 'https://api.openai.com/v1'}`);
  if (authMode === 'oauth') {
    console.log(`  Auth:     oauth → ${process.env.TOKEN_URL}`);
    console.log(`  Header:   ${headerName}: ${prefix ? prefix + ' <token>' : '<token>'}`);
    console.log(`  Debug:    ${process.env.TOKEN_DEBUG === 'true' ? 'ON' : 'off'}`);
  } else {
    console.log(`  Auth:     apikey`);
  }
  console.log();
});
