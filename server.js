// server.js — Twilio (outbound) + OpenAI Realtime (voz) + Monitor en vivo (browser)
// Node 22+, ES Modules

import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Ping simple
app.get('/', (_, res) => res.status(200).send('OK: bot de voz activo'));

// ======= 1) STREAM DE AUDIO: Twilio <-> OpenAI Realtime =======
const server = http.createServer(app);

// Colección de monitores conectados (navegadores)
const monitorClients = new Set();

// WebSocket para el stream de Twilio
const wssTwilio = new WebSocketServer({ server, path: '/ws/twilio' });

// WebSocket para monitores (escuchar la llamada en vivo en el navegador)
const wssMonitor = new WebSocketServer({ server, path: '/ws/monitor' });
wssMonitor.on('connection', (ws, req) => {
  // Seguridad opcional: requiere ?key=MONITOR_KEY
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = url.searchParams.get('key');
  if (process.env.MONITOR_KEY && key !== process.env.MONITOR_KEY) {
    try { ws.close(); } catch {}
    return;
  }
  monitorClients.add(ws);
  ws.on('close', () => monitorClients.delete(ws));
});

// Handler del stream Twilio <-> OpenAI
wssTwilio.on('connection', async (twilioWS) => {
  let streamSid = null;

  // Conexión a OpenAI Realtime (voz en tiempo real)
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
    // Configura sesión (español y salida μ-law 8k para Twilio)
    rt.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: [
          "Habla SIEMPRE en español latino neutro.",
          "Responde con voz natural, frases cortas y amables.",
          "Si el usuario interrumpe, deja de hablar y escucha."
        ].join(" "),
        output_audio_format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }
    }));

    // Saludo inicial para anclar idioma
    rt.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: "Hola, soy tu asistente. ¿En qué puedo ayudarte?"
      }
    }));

    console.log('Conectado a OpenAI Realtime ✅');
  });

  // Salida de audio de la IA -> Twilio + Monitores ("out")
  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'output_audio.delta' && streamSid) {
        // Enviar a la llamada (Twilio)
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.delta } // μ-law 8k b64
        }));
        twilioWS.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: 'ai-chunk' }
        }));

        // Retransmitir a monitores
        const mon = JSON.stringify({ kind: 'out', codec: 'mulaw', sr: 8000, b64: msg.delta });
        for (const m of monitorClients) {
          try { m.send(mon); } catch {}
        }
      }
    } catch (e) {
      console.error('Error parseando mensaje OpenAI:', e);
    }
  });

  // Audio entrante de Twilio -> IA + Monitores ("in")
  twilioWS.on('message', (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.event === 'start') {
      streamSid = evt.start.streamSid;
      console.log('Stream iniciado con SID:', streamSid);
    }

    if (evt.event === 'media') {
      const muLawB64 = evt.media.payload; // μ-law 8k base64

      // Enviar a OpenAI como entrada
      rt.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: muLawB64,
        format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 }
      }));

      // Retransmitir a monitores
      const msg = JSON.stringify({ kind: 'in', codec: 'mulaw', sr: 8000, b64: muLawB64 });
      for (const m of monitorClients) {
        try { m.send(msg); } catch {}
      }
    }

    if (evt.event === 'stop') {
      console.log('Stream finalizado');
      try { rt.close(); } catch {}
    }
  });

  // Commit periódico simple (mejorable con VAD por silencio)
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

// Iniciar llamada: GET /call?to=+58XXXXXXXXXX (E.164)
app.get('/call', async (req, res) => {
  try {
    const to   = req.query.to;
    const from = process.env.TWILIO_NUMBER;
    if (!to) return res.status(400).json({ error: 'Falta parámetro ?to=' });

    const call = await twilioClient.calls.create({
      to,
      from,
      url: `https://${req.headers.host}/outbound-voice`
    });

    res.json({ success: true, callSid: call.sid, to, from });
  } catch (err) {
    console.error('Error creando llamada:', err);
    res.status(500).json({ error: err.message });
  }
});

// TwiML al contestar la llamada saliente: abre el stream WSS
app.post('/outbound-voice', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/ws/twilio" name="voice-assistant"/>
      </Connect>
    </Response>
  `);
});

// ======= 3) Página de monitor en vivo (escuchar "in" y "out") =======
app.get('/monitor', (req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Monitor de llamada</title>
<body style="font-family:system-ui; max-width:800px; margin:32px auto; line-height:1.4">
  <h2>Monitor de llamada (en vivo)</h2>
  <p>Escucha los dos canales:
    <b>Caller (in)</b> = la persona a la que llamas,
    <b>Bot (out)</b> = la voz de la IA.
  </p>
  <p>Estado: <span id="state">Desconectado</span></p>
  <div style="margin:10px 0">
    <label>Key (opcional si configuraste <code>MONITOR_KEY</code>): 
      <input id="key" placeholder="ingresa tu clave si aplica" style="width:280px">
    </label>
    <button id="connect">Conectar</button>
  </div>
  <div style="margin:10px 0">
    <label><input type="checkbox" id="chIn" checked> Reproducir Caller (in)</label>
    <label style="margin-left:16px"><input type="checkbox" id="chOut" checked> Reproducir Bot (out)</label>
  </div>
  <hr>
  <p style="font-size:12px;color:#444">
    Nota: la calidad es 8 kHz (telefónica). El navegador re-muestrea a tu tarjeta de audio para que puedas oírlo.
  </p>

  <script>
    // μ-law -> PCM16
    function muLawDecode(sample){
      sample = ~sample & 0xFF;
      const sign = (sample & 0x80) ? -1 : 1;
      const exponent = (sample >> 4) & 0x07;
      const mantissa = sample & 0x0F;
      const BIAS = 33;
      let magnitude = ((mantissa << 4) + BIAS) << (exponent + 3);
      if (magnitude > 32767) magnitude = 32767;
      return (sign * magnitude) | 0;
    }
    function decodeMuLaw(bytes){
      const out = new Int16Array(bytes.length);
      for (let i=0;i<bytes.length;i++) out[i] = muLawDecode(bytes[i]);
      return out;
    }
    // Re-muestreo lineal 8k -> sampleRate de AudioContext
    function resampleInt16(int16, inRate, outRate){
      if (inRate === outRate) return int16;
      const ratio = outRate / inRate;
      const out = new Int16Array(Math.round(int16.length * ratio));
      for (let i=0;i<out.length;i++){
        const src = i / ratio;
        const i0 = Math.floor(src), i1 = Math.min(int16.length-1, i0+1);
        const frac = src - i0;
        out[i] = (int16[i0]*(1-frac) + int16[i1]*frac) | 0;
      }
      return out;
    }
    async function makePlayer(){
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const queue = [];
      let playing = false;
      async function playChunk(int16, inRate){
        const pcm = resampleInt16(int16, inRate, ctx.sampleRate);
        const f32 = new Float32Array(pcm.length);
        for (let i=0;i<pcm.length;i++) f32[i] = Math.max(-1, Math.min(1, pcm[i]/32768));
        const buf = ctx.createBuffer(1, f32.length, ctx.sampleRate);
        buf.getChannelData(0).set(f32);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
        await new Promise(r => src.onended = r);
      }
      async function loop(){
        if (playing) return;
        playing = true;
        while (true){
          const it = queue.shift();
          if (!it){ await new Promise(r => setTimeout(r, 5)); continue; }
          await playChunk(it.data, it.sr);
        }
      }
      return {
        enqueue(int16, sr){ queue.push({ data:int16, sr }); },
        start(){ loop(); },
        context: ctx
      };
    }

    const stateEl = document.getElementById('state');
    const keyEl = document.getElementById('key');
    const btn = document.getElementById('connect');
    const chIn = document.getElementById('chIn');
    const chOut = document.getElementById('chOut');

    let player;
    btn.onclick = async () => {
      if (!player){
        player = await makePlayer();
        player.start();
      }
      const key = keyEl.value.trim();
      const url = location.origin.replace('http','ws') + '/ws/monitor' + (key ? ('?key='+encodeURIComponent(key)) : '');
      const ws = new WebSocket(url);
      ws.onopen = () => stateEl.textContent = 'Conectado';
      ws.onclose = () => stateEl.textContent = 'Desconectado';
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data); // { kind:'in'|'out', codec:'mulaw', sr:8000, b64:'...' }
        if (m.codec !== 'mulaw') return;
        if (m.kind === 'in' && !chIn.checked) return;
        if (m.kind === 'out' && !chOut.checked) return;

        const bin = atob(m.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);

        const pcm16 = decodeMuLaw(bytes);
        player.enqueue(pcm16, m.sr || 8000);
      };
    };
  </script>
</body>`);
});

// ======= 4) TwiML para llamadas salientes (cuando contestan) =======
app.post('/outbound-voice', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/ws/twilio" name="voice-assistant"/>
      </Connect>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
