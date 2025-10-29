import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const app = express();
app.use(express.urlencoded({ extended: false }));

// 1) Webhook Twilio: devuelve TwiML para abrir el Stream bidireccional
app.post('/voice', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/ws/twilio" name="cr-assistant"/>
      </Connect>
    </Response>
  `);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/twilio' });

wss.on('connection', async (twilioWS) => {
  let streamSid = null;

  // 2) Conexión a OpenAI Realtime
  const rt = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // ✅ corregido
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  // 3) Configurar sesión Realtime
  rt.on('open', () => {
    rt.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: 'Eres un asistente telefónico en español, responde con voz natural y breve.',
        output_audio_format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }
    }));
    console.log('Conectado a OpenAI Realtime ✅');
  });

  // 4) Reenviar audio de IA → Twilio
  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output_audio.delta' && streamSid) {
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.delta }
        }));
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

  // 5) Recibir audio de Twilio → enviar a IA
  twilioWS.on('message', (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.event === 'start') {
      streamSid = evt.start.streamSid;
      console.log('Stream iniciado con SID:', streamSid);
    }

    if (evt.event === 'media') {
      const muLawB64 = evt.media.payload;
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

  // Commit periódico (puedes mejorarlo con VAD)
  const commit = () => rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  const timer = setInterval(commit, 400);

  twilioWS.on('close', () => {
    clearInterval(timer);
    try { rt.close(); } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
