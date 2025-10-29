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

// 2) WebSocket que "habla con Twilio"
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/twilio' });

wss.on('connection', async (twilioWS) => {
  let streamSid = null;

  // 3) Conexión a OpenAI Realtime (voz en tiempo real)
  //    Nota: algunos releases permiten pedir salida ya en mu-law 8k; si no, ver comentario "TRANSCODING".
  const rt = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime',
    {
      headers: {
        Authorization: Bearer ${process.env.OPENAI_API_KEY},
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  rt.on('open', () => {
    // Ajusta "instrucciones" y formato de salida de audio
    rt.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: 'Eres un asistente telefónico en español. Sé breve, natural y amable.',
        // Pide salida en mu-law 8k si el modelo/versión lo soporta (evitas transcodificar):
        output_audio_format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }
    }));
  });

  // 4) Respuestas de OpenAI → mandarlas a la llamada (Twilio)
  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output_audio.delta' && streamSid) {
        // rt nos da audio como base64 (idealmente mu-law 8k). Lo enviamos a Twilio:
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.delta }
        }));
        // Marca opcional para sincronía
        twilioWS.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: 'ai-chunk' }
        }));
      }
      // Cuando el modelo indique fin de la respuesta (varía por versión):
      if (msg.type === 'output_audio.complete' && streamSid) {
        // Nada especial; Twilio ya habrá reproducido lo enviado.
      }
    } catch (e) { /* noop */ }
  });

  // 5) Eventos desde Twilio (audio entrante del llamante)
  twilioWS.on('message', (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.event === 'start') {
      streamSid = evt.start.streamSid;
    }

    if (evt.event === 'media') {
      // Twilio envía audio mu-law 8k base64 del llamante
      const muLawB64 = evt.media.payload;

      // Enviamos el audio entrante al buffer de entrada del modelo:
      // Si tu versión de Realtime acepta mu-law directo, especifica el formato.
      rt.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: muLawB64,
        format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }));
    }

    if (evt.event === 'mark') {
      // Confirmación de Twilio que ya reprodujo un chunk (opcional)
    }

    if (evt.event === 'stop') {
      try { rt.close(); } catch {}
    }
  });

  // "Commit" del buffer para que el modelo empiece a hablar sin esperar demasiado.
  // Puedes dispararlo por VAD (detección de silencio) o cada X ms.
  const commit = () => rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  // Ejemplo simple: commit periódico cada 400 ms:
  const timer = setInterval(commit, 400);

  twilioWS.on('close', () => {
    clearInterval(timer);
    try { rt.close(); } catch {}
  });
});

server.listen(process.env.PORT || 3000, () =>
  console.log('Servidor listo en :' + (process.env.PORT || 3000))
);

/*
TRANSCODING (si hiciera falta):
- Twilio SIEMPRE envía mu-law 8 kHz mono; si tu versión de Realtime no acepta mu-law,
  debes decodificar a PCM16 (y posiblemente remuestrear), y a la vuelta codificar otra vez a mu-law 8K.
