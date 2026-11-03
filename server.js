// server.js - Key-rotating proxy for UnoRouter (Chub AI / SillyTavern)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '50mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : {}));

const UNO_API_BASE = process.env.UNO_API_BASE || 'https://api.unorouter.com/v1';

// Keys: UNO_API_KEY1, UNO_API_KEY2, UNO_API_KEY3 (also supports UNO_API_KEY and UNO_API_KEYS="k1,k2")
const UNO_API_KEYS = [
  ...(process.env.UNO_API_KEYS || '').split(','),
  process.env.UNO_API_KEY,
  process.env.UNO_API_KEY1,
  process.env.UNO_API_KEY2,
  process.env.UNO_API_KEY3
].map(k => (k || '').trim()).filter(Boolean);

if (UNO_API_KEYS.length === 0) {
  console.error('FATAL: No UnoRouter keys configured! Set UNO_API_KEY1/2/3.');
}

// Rotates on every request (every reply)
let keyIndex = 0;
function getNextKey() {
  const key = UNO_API_KEYS[keyIndex % UNO_API_KEYS.length];
  keyIndex = (keyIndex + 1) % UNO_API_KEYS.length;
  return key;
}

const SHOW_REASONING = process.env.SHOW_REASONING === 'true';

// Left = name shown in Chub's dropdown, right = real UnoRouter model ID.
// Add more lines as needed. Unlisted names are passed through unchanged.
const MODEL_MAPPING = {
  'gpt-4o': 'gemma-4-31b-it:free'
  // 'gpt-4': 'UNOROUTER-MODEL-ID',
  // 'gpt-4-turbo': 'UNOROUTER-MODEL-ID',
  // 'gpt-3.5-turbo': 'UNOROUTER-MODEL-ID',
};

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemma-4-31b-it:free';

const unoClient = axios.create({
  baseURL: UNO_API_BASE,
  timeout: 300000
});

const PROXY_SECRET = process.env.PROXY_SECRET;

function checkAuth(req, res) {
  if (!PROXY_SECRET) {
    res.status(500).json({ error: { message: 'Server misconfigured: PROXY_SECRET is not set.', type: 'server_error' } });
    return false;
  }
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (token !== PROXY_SECRET) {
    res.status(401).json({ error: { message: 'Invalid API key.', type: 'invalid_request_error' } });
    return false;
  }
  return true;
}

// Rotates keys; if one fails (rate limit / bad key / out of credit), tries the next
async function postWithKeyFallback(payload, config) {
  if (UNO_API_KEYS.length === 0) {
    const err = new Error('No UnoRouter keys configured on the server.');
    err.response = { status: 500, data: { error: err.message } };
    throw err;
  }
  let lastError;
  for (let i = 0; i < UNO_API_KEYS.length; i++) {
    const key = getNextKey();
    try {
      return await unoClient.post('/chat/completions', payload, {
        ...config,
        headers: { ...config.headers, Authorization: `Bearer ${key}` }
      });
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (![401, 402, 403, 429].includes(status)) throw err;
      console.log(`[Key Fallback] Key #${i + 1} failed with ${status}, trying next...`);
    }
  }
  throw lastError;
}

function stripThinkTagsFromText(text) {
  if (!text) return text;
  let result = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const closeIdx = result.indexOf('</think>');
  if (closeIdx !== -1) result = result.slice(closeIdx + '</think>'.length);
  return result.trim();
}

function makeThinkStripper(leadBufferLimit = 500) {
  let insideThink = false;
  let carry = '';
  let leadResolved = false;
  let leadBuffer = '';
  const OPEN = '<think>';
  const CLOSE = '</think>';

  function processTagged(chunkText) {
    let text = carry + (chunkText || '');
    carry = '';
    let output = '';
    while (text.length) {
      const idx = text.indexOf('<');
      if (!insideThink) {
        if (idx === -1) { output += text; text = ''; }
        else {
          output += text.slice(0, idx);
          const remainder = text.slice(idx);
          if (remainder.length < OPEN.length && OPEN.startsWith(remainder)) { carry = remainder; text = ''; }
          else if (remainder.startsWith(OPEN)) { insideThink = true; text = remainder.slice(OPEN.length); }
          else { output += remainder[0]; text = remainder.slice(1); }
        }
      } else {
        if (idx === -1) { text = ''; }
        else {
          const remainder = text.slice(idx);
          if (remainder.length < CLOSE.length && CLOSE.startsWith(remainder)) { carry = remainder; text = ''; }
          else if (remainder.startsWith(CLOSE)) { insideThink = false; text = remainder.slice(CLOSE.length); }
          else { text = remainder.slice(1); }
        }
      }
    }
    return output;
  }

  function flush() {
    let output = '';
    if (!leadResolved) {
      leadResolved = true;
      const buffered = leadBuffer;
      leadBuffer = '';
      output += processTagged(buffered);
    }
    if (carry) { output += carry; carry = ''; }
    return output;
  }

  return {
    strip(chunkText) {
      if (leadResolved) return processTagged(chunkText);
      leadBuffer += (chunkText || '');
      const closeIdx = leadBuffer.indexOf(CLOSE);
      const openIdx = leadBuffer.indexOf(OPEN);
      if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        const rest = leadBuffer.slice(closeIdx + CLOSE.length);
        leadResolved = true;
        leadBuffer = '';
        return processTagged(rest);
      }
      if (openIdx !== -1 || leadBuffer.length >= leadBufferLimit) {
        const buffered = leadBuffer;
        leadResolved = true;
        leadBuffer = '';
        return processTagged(buffered);
      }
      return '';
    },
    flush
  };
}

function sanitizeError(errorDetails) {
  let text = typeof errorDetails === 'object' ? JSON.stringify(errorDetails) : String(errorDetails);
  return text.replace(/(sk-|uno-)[a-zA-Z0-9\-_]+/g, '[REDACTED]');
}

app.get('/health', (req, res) => res.json({
  status: UNO_API_KEYS.length > 0 ? 'ok' : 'misconfigured',
  proxy: 'Chub AI to UnoRouter',
  keysConfigured: UNO_API_KEYS.length
}));

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'unorouter-proxy'
    }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (req.socket) req.socket.setTimeout(600000);

  try {
    const { model, messages, stream } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: "Missing 'messages' array.", type: 'invalid_request_error' } });
    }

    const unoModel = model ? (MODEL_MAPPING[model] || model) : DEFAULT_MODEL;

    const unoRequest = { ...req.body, model: unoModel, stream: Boolean(stream) };

    const response = await postWithKeyFallback(unoRequest, {
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
      }, 15000);
      res.on('close', () => clearInterval(keepAlive));

      let buffer = '';
      let reasoningStarted = false;
      const stripInlineThink = makeThinkStripper();

      response.data.on('data', (chunk) => {
        try {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          lines.forEach(line => {
            if (!line.startsWith('data: ')) return;

            if (line.includes('[DONE]')) {
              const trailing = stripInlineThink.flush();
              if (trailing) {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: trailing }, finish_reason: null }] })}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              return;
            }

            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;

                if (SHOW_REASONING) {
                  let combined = '';
                  if (reasoning && !reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
                  else if (reasoning) { combined = reasoning; }

                  if (content && reasoningStarted) { combined += '\n</think>\n\n' + content; reasoningStarted = false; }
                  else if (content) { combined += content; }

                  data.choices[0].delta.content = combined;
                } else {
                  data.choices[0].delta.content = stripInlineThink.strip(content || '');
                }
                delete data.choices[0].delta.reasoning_content;
              }

              if (Array.isArray(data.choices) && data.choices.length === 0) return;
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n\n');
            }
          });
        } catch (streamError) {
          console.error('Stream processing error:', streamError.message);
        }
      });

      response.data.on('end', () => {
        clearInterval(keepAlive);
        const trailing = stripInlineThink.flush();
        if (trailing && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: trailing }, finish_reason: null }] })}\n\n`);
        }
        res.end();
      });
      response.data.on('error', () => {
        clearInterval(keepAlive);
        if (!res.writableEnded) res.end();
      });
    } else {
      const openaiResponse = {
        id: response.data.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || unoModel,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${fullContent}`;
          } else if (!SHOW_REASONING) {
            fullContent = stripThinkTagsFromText(fullContent);
          }
          return {
            index: choice.index,
            message: { role: choice.message.role, content: fullContent },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      res.json(openaiResponse);
    }
  } catch (error) {
    if (error.response?.data?.on) {
      const chunks = [];
      for await (const c of error.response.data) chunks.push(c);
      error.response.data = Buffer.concat(chunks).toString();
    }

    const status = error.response?.status || 500;
    const errorDetails = error.response?.data || error.message;
    console.error(`UnoRouter Error [${status}]:`, JSON.stringify(errorDetails));

    if (!res.headersSent) {
      res.status(status).json({
        error: { message: sanitizeError(errorDetails), type: 'invalid_request_error', code: status }
      });
    }
  }
});

app.all('*', (req, res) => res.status(404).json({ error: { message: 'Endpoint not found', code: 404 } }));

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
  server.timeout = 600000;
}

module.exports = app;
