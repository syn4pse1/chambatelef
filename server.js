// server.js — Twilio (outbound) + OpenAI Realtime (voz en tiempo real) + Render (HTTPS/WSS)
// Node 22+, ES Modules

import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Rutas utilitarias ---
app.get('/', (_, res) => res.status(200).send('OK: bot de voz activo'));

// ======= 1) STREAM DE AUDIO TWILIO <-> OPENAI REALTIME =======
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/twilio' });

wss.on('connection', async (twilioWS) => {
  let streamSid = null;

  // Conecta a OpenAI Realtime (voz en vivo)
  const rt = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  rt.on('open', () => {
    // Configura la sesión: español, tono breve; pide salida en mu-law 8k (ideal para Twilio)
    rt.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions:
          'Eres un asistente telefónico en español. Responde con voz natural, frases breves y amables. ' +
          'Si el usuario interrumpe, deja de hablar y escucha.',
        output_audio_format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }
    }));
    console.log('Conectado a OpenAI Realtime ✅');
  });

  // Salida de audio de la IA --> reenviar a la llamada
  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'output_audio.delta' && streamSid) {
        // `delta` ya viene en base64 (μ-law 8k mono) si la sesión lo permite
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.delta }
        }));
        // Marca opcional para sincronía / métricas
        twilioWS.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: 'ai-chunk' }
        }));
      }
    } catch (e) {
      console.error('Error parseando mensaje OpenAI:', e);
    }
  });

  // Entrada de audio de la llamada --> enviar a la IA
  twilioWS.on('message', (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.event === 'start') {
      streamSid = evt.start.streamSid;
      console.log('Stream iniciado con SID:', streamSid);
    }

    if (evt.event === 'media') {
      const muLawB64 = evt.media.payload; // μ-law 8k base64 desde Twilio
      rt.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: muLawB64,
        format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }));
    }

    if (evt.event === 'stop') {
      console.log('Stream finalizado');
      try { rt.close(); } catch {}
    }
  });

  // Commit periódico (simple). Para producción, cámbialo por VAD (silencio)
  const commit = () => rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  const timer = setInterval(commit, 400);

  twilioWS.on('close', () => {
    clearInterval(timer);
    try { rt.close(); } catch {}
  });
});

// ======= 2) OUTBOUND CALL (llamada saliente) =======
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

// Endpoint para INICIAR una llamada saliente:
// GET /call?to=+58XXXXXXXXXX  (Venezuela) o el país que necesites
app.get('/call', async (req, res) => {
  try {
    const to   = req.query.to;                 // destino (E.164)
    const from = process.env.TWILIO_NUMBER;    // tu número Twilio (E.164)

    if (!to) return res.status(400).json({ error: 'Falta parámetro ?to=' });

    const call = await twilioClient.calls.create({
      to,
      from,
      // Cuando contesten, Twilio pedirá TwiML a esta URL:
      url: `https://${req.headers.host}/outbound-voice`
    });

    res.json({ success: true, callSid: call.sid, to, from });
  } catch (err) {
    console.error('Error creando llamada:', err);
    res.status(500).json({ error: err.message });
  }
});

// TwiML que Twilio usa cuando el destinatario CONTESTA la llamada saliente
app.post('/outbound-voice', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/ws/twilio" name="voice-assistant"/>
      </Connect>
    </Response>
  `);
});

// ======= 3) (Opcional) INBOUND CALL (si algún día quieres recibir llamadas) =======
// Configura este webhook en "A CALL COMES IN" del número, si deseas inbound.
// app.post('/voice', (req, res) => {
//   res.type('text/xml').send(`
//     <Response>
//       <Connect>
//         <Stream url="wss://${req.headers.host}/ws/twilio" name="voice-assistant"/>
//       </Connect>
//     </Response>
//   `);
// });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
