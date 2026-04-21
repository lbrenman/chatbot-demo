require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ─────────────────────────────────────────────────────────────────
function getEndpointConfig(endpoint) {
  // endpoint = 'A' or 'B'
  const e = (endpoint === 'B') ? 'B' : 'A';
  return {
    apiBaseUrl: process.env[`API_BASE_URL_${e}`] || 'https://api.openai.com/v1',
    apiKey:     process.env[`API_KEY_${e}`],
    systemPrompt: process.env[`SYSTEM_PROMPT_${e}`] || 'You are a helpful assistant.',
    label:      process.env[`ENDPOINT_${e}_LABEL`] || `Endpoint ${e}`,
  };
}

// ── Config endpoint ──────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    title:          process.env.CHATBOT_TITLE    || 'AI Assistant',
    subtitle:       process.env.CHATBOT_SUBTITLE || 'How can I help you today?',
    primaryColor:   process.env.PRIMARY_COLOR    || '#0066cc',
    secondaryColor: process.env.SECONDARY_COLOR  || '#0052a3',
    endpointALabel: process.env.ENDPOINT_A_LABEL || 'Endpoint A',
    endpointBLabel: process.env.ENDPOINT_B_LABEL || 'Endpoint B',
  });
});

// ── Models endpoint — fetches from whichever endpoint is selected ────────────
app.get('/api/models', async (req, res) => {
  const endpoint = req.query.endpoint || 'A';
  const { apiBaseUrl, apiKey, label } = getEndpointConfig(endpoint);

  if (!apiKey) {
    return res.status(500).json({ error: `API_KEY_${endpoint} is not configured on the server.` });
  }

  try {
    const response = await fetch(`${apiBaseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Models API error:', response.status, errorText);
      return res.status(response.status).json({ error: `Models API returned ${response.status}` });
    }

    const data = await response.json();
    const models = (data.data || data.models || [])
      .map(m => m.id || m.name || m)
      .filter(Boolean)
      .sort();

    res.json({ models });

  } catch (err) {
    console.error('Models fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch models from API.' });
  }
});

// ── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, model, endpoint } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const { apiBaseUrl, apiKey, systemPrompt, label } = getEndpointConfig(endpoint);
  const modelName = model || process.env.MODEL_NAME || 'gpt-4o';

  if (!apiKey) {
    return res.status(500).json({ error: `API key for ${label} is not configured.` });
  }

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  console.log(`[${label}] ${modelName} — ${messages[messages.length - 1]?.content?.slice(0, 60)}...`);

  try {
    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: fullMessages,
        temperature: 0,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API error:', response.status, errorText);
      return res.status(response.status).json({
        error: `API returned ${response.status}: ${errorText}`
      });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ reply });

  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: `Failed to reach ${label}. Check API_BASE_URL_${endpoint}.` });
  }
});

// ── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const cfgA = getEndpointConfig('A');
  const cfgB = getEndpointConfig('B');
  console.log(`\nChatbot demo running on http://localhost:${PORT}`);
  console.log(`  Title: ${process.env.CHATBOT_TITLE || 'AI Assistant'}`);
  console.log(`  [A] ${cfgA.label}: ${cfgA.apiBaseUrl}`);
  console.log(`  [B] ${cfgB.label}: ${cfgB.apiBaseUrl}\n`);
});
