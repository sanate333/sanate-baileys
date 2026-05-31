/**
 * Audio TTS Module — Gemini TTS + WhatsApp Voice Notes
 * Handles: TTS generation, OGG conversion, per-conversation audio counting, settings persistence
 */
const { spawn } = require('child_process');
const apiTracker = require('./api-tracker');

// Try bundled ffmpeg-static first, fall back to system ffmpeg
let ffmpegBin = 'ffmpeg';
try { ffmpegBin = require('ffmpeg-static'); console.log('[AudioTTS] ffmpeg-static:', ffmpegBin); }
catch(e) { console.log('[AudioTTS] ffmpeg-static not found, using system ffmpeg'); }

let supabaseClient = null;
let sockRef = null;

// ── Audio settings (in-memory, loaded from Supabase app_config) ──
let audioConfig = {
  voice: 'Aoede',
  maxAudiosPerConvo: 1,
  respondWithAudio: false,
  geminiApiKey: '',
};

// ── Per-conversation audio count: chatJid → { count, windowStart } ──
const audioCountMap = new Map();
const WINDOW_24H = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
function initAudioTTS(supabase, socket) {
  supabaseClient = supabase;
  sockRef = socket;
  loadAudioSettings().catch(e => console.error('[AudioTTS] Init load error:', e.message));
}

function updateAudioSocket(socket) {
  sockRef = socket;
}

// ═══════════════════════════════════════════════════════════
// SETTINGS PERSISTENCE
// ═══════════════════════════════════════════════════════════
async function loadAudioSettings() {
  if (!supabaseClient) return;
  try {
    const keysToLoad = [
      'AUDIO_VOICE', 'AUDIO_MAX_PER_CONVO', 'AUDIO_RESPOND_WITH_AUDIO',
      'GEMINI_API_KEY_MONITOR', 'GEMINI_API_KEY_GEN7'
    ];
    const { data, error } = await supabaseClient
      .from('app_config').select('key, value').in('key', keysToLoad);
    if (error) throw error;

    const cfg = {};
    (data || []).forEach(row => { cfg[row.key] = row.value; });

    if (cfg.AUDIO_VOICE) audioConfig.voice = cfg.AUDIO_VOICE;
    if (cfg.AUDIO_MAX_PER_CONVO) audioConfig.maxAudiosPerConvo = Math.max(1, parseInt(cfg.AUDIO_MAX_PER_CONVO) || 1);
    if (cfg.AUDIO_RESPOND_WITH_AUDIO) audioConfig.respondWithAudio = cfg.AUDIO_RESPOND_WITH_AUDIO === 'true';
    // Monitor API key first, Generacion 7 as fallback
    audioConfig.geminiApiKey = cfg.GEMINI_API_KEY_MONITOR || cfg.GEMINI_API_KEY_GEN7 || '';

    console.log('[AudioTTS] Settings loaded — voice:', audioConfig.voice,
      '| max/convo:', audioConfig.maxAudiosPerConvo,
      '| respondWithAudio:', audioConfig.respondWithAudio,
      '| hasKey:', !!audioConfig.geminiApiKey);
  } catch (err) {
    console.error('[AudioTTS] Error loading settings:', err.message);
  }
}

async function saveAudioSettings(settings) {
  // Update in-memory immediately
  if (settings.voice !== undefined) audioConfig.voice = settings.voice;
  if (settings.maxAudiosPerConvo !== undefined) audioConfig.maxAudiosPerConvo = Math.max(1, parseInt(settings.maxAudiosPerConvo) || 1);
  if (settings.respondWithAudio !== undefined) audioConfig.respondWithAudio = !!settings.respondWithAudio;

  if (!supabaseClient) return;
  try {
    const rows = [];
    if (settings.voice !== undefined) rows.push({ key: 'AUDIO_VOICE', value: audioConfig.voice });
    if (settings.maxAudiosPerConvo !== undefined) rows.push({ key: 'AUDIO_MAX_PER_CONVO', value: String(audioConfig.maxAudiosPerConvo) });
    if (settings.respondWithAudio !== undefined) rows.push({ key: 'AUDIO_RESPOND_WITH_AUDIO', value: String(audioConfig.respondWithAudio) });

    for (const row of rows) {
      await supabaseClient.from('app_config').upsert({ key: row.key, value: row.value }, { onConflict: 'key' });
    }
    console.log('[AudioTTS] Settings saved to Supabase:', settings);
  } catch (err) {
    console.error('[AudioTTS] Error saving settings:', err.message);
    throw err;
  }
}

function getAudioSettings() {
  const now = Date.now();
  let audioUsedToday = 0;
  audioCountMap.forEach((entry) => {
    if (now - entry.windowStart < WINDOW_24H) audioUsedToday += entry.count;
  });
  return {
    voice: audioConfig.voice,
    maxAudiosPerConvo: audioConfig.maxAudiosPerConvo,
    respondWithAudio: audioConfig.respondWithAudio,
    hasGeminiKey: !!audioConfig.geminiApiKey,
    audio_used_today: audioUsedToday,
    audio_limit: audioConfig.maxAudiosPerConvo * 100,
    convo_used: audioCountMap.size,
    convo_limit: 1000,
  };
}

// ═══════════════════════════════════════════════════════════
// AUDIO COUNT TRACKING
// ═══════════════════════════════════════════════════════════
function checkAndIncrementAudioCount(chatJid) {
  const now = Date.now();
  let entry = audioCountMap.get(chatJid);

  // Reset if 24h window expired (new conversation window)
  if (!entry || (now - entry.windowStart) > WINDOW_24H) {
    entry = { count: 0, windowStart: now };
  }

  if (entry.count >= audioConfig.maxAudiosPerConvo) {
    console.log(`[AudioTTS] Limit reached for ${chatJid}: ${entry.count}/${audioConfig.maxAudiosPerConvo}`);
    return false;
  }

  entry.count++;
  audioCountMap.set(chatJid, entry);
  console.log(`[AudioTTS] Audio ${entry.count}/${audioConfig.maxAudiosPerConvo} for ${chatJid.split('@')[0]}`);
  return true;
}

// ═══════════════════════════════════════════════════════════
// GEMINI TTS
// ═══════════════════════════════════════════════════════════
async function callGeminiTTS(text, voiceName, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const _atKey = apiKey;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      response_modalities: ['AUDIO'],
      speech_config: {
        voice_config: {
          prebuilt_voice_config: { voice_name: voiceName || 'Aoede' }
        }
      }
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  try { apiTracker.track(_atKey, res.ok, res.status).catch(()=>{}); } catch(e) {}

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini TTS ${resp.status}: ${errText.substring(0, 300)}`);
  }

  const data = await resp.json();
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  // Gemini returns camelCase (inlineData) not snake_case (inline_data)
  const inlineData = part?.inlineData || part?.inline_data;
  if (!inlineData?.data) {
    throw new Error('No audio in Gemini TTS response: ' + JSON.stringify(data).substring(0, 200));
  }

  const mime = inlineData.mimeType || inlineData.mime_type || 'audio/wav';
  console.log(`[AudioTTS] Gemini TTS raw mime: ${mime}, data length: ${inlineData.data.length}`);

  return {
    buffer: Buffer.from(inlineData.data, 'base64'),
    mimeType: mime,
  };
}

// ═══════════════════════════════════════════════════════════
// WAVEFORM GENERATION (for WhatsApp voice note visualization)
// ═══════════════════════════════════════════════════════════

/**
 * Generate a waveform array (64 bytes, values 0-100) from audio buffer.
 * WhatsApp uses this to render the frequency bars on voice notes.
 * Without it, TTS audio (very uniform volume) shows as a flat line.
 */
function generateWaveform(audioBuffer) {
  const SAMPLES = 64;
  const waveform = new Array(SAMPLES);
  const len = audioBuffer.length;
  const chunkSize = Math.floor(len / SAMPLES);

  for (let i = 0; i < SAMPLES; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, len);
    let sum = 0;
    for (let j = start; j < end; j++) {
      // Treat each byte as unsigned amplitude centered at 128
      sum += Math.abs(audioBuffer[j] - 128);
    }
    const avg = sum / (end - start);
    // Scale to 0-100 range with amplification for TTS audio
    waveform[i] = Math.min(100, Math.round((avg / 80) * 100));
  }

  // Add natural variation so it doesn't look robotic
  // TTS audio is very uniform, so we add slight random organic variation
  for (let i = 0; i < SAMPLES; i++) {
    const base = waveform[i];
    // Ensure minimum visible bar height (at least 15)
    const boosted = Math.max(15, base);
    // Add ±12 random organic variation
    const variation = Math.round((Math.random() - 0.5) * 24);
    waveform[i] = Math.min(100, Math.max(5, boosted + variation));
  }

  // Smooth: average with neighbors for natural look
  const smoothed = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const prev = i > 0 ? waveform[i - 1] : waveform[i];
    const next = i < SAMPLES - 1 ? waveform[i + 1] : waveform[i];
    smoothed[i] = Math.round((prev + waveform[i] * 2 + next) / 4);
  }

  return Buffer.from(smoothed);
}

/**
 * Estimate audio duration in seconds from OGG/WAV buffer size.
 * OGG Opus at 64kbps ≈ 8KB/s; WAV 48kHz mono 16bit ≈ 96KB/s
 */
function estimateDuration(audioBuffer, isOgg) {
  const bytesPerSec = isOgg ? 8000 : 96000;
  return Math.max(1, Math.round(audioBuffer.length / bytesPerSec));
}

// ═══════════════════════════════════════════════════════════
// AUDIO → OGG OPUS CONVERSION (supports WAV, raw PCM L16, etc.)
// ═══════════════════════════════════════════════════════════
function audioToOgg(audioBuffer, mimeType) {
  return new Promise((resolve) => {
    // Build ffmpeg input flags based on mime type
    let inputFlags;
    if (mimeType && mimeType.includes('L16')) {
      // Raw PCM L16 (signed 16-bit little-endian)
      // Parse sample rate from mime: "audio/L16;codec=pcm;rate=24000"
      const rateMatch = mimeType.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? rateMatch[1] : '24000';
      inputFlags = ['-f', 's16le', '-ar', sampleRate, '-ac', '1', '-i', 'pipe:0'];
      console.log(`[AudioTTS] ffmpeg input: raw PCM s16le @ ${sampleRate}Hz`);
    } else {
      // WAV or other format — let ffmpeg auto-detect
      inputFlags = ['-f', 'wav', '-i', 'pipe:0'];
    }

    const proc = spawn(ffmpegBin, [
      '-y', ...inputFlags,
      '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1',
      '-f', 'ogg', 'pipe:1'
    ]);

    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', () => {}); // suppress ffmpeg verbose output

    proc.on('error', err => {
      console.warn('[AudioTTS] ffmpeg spawn error:', err.message, '— will use WAV');
      resolve(null);
    });

    proc.on('close', code => {
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        console.warn('[AudioTTS] ffmpeg exit', code, 'no output — will use WAV');
        resolve(null);
      }
    });

    proc.stdin.write(audioBuffer);
    proc.stdin.end();
  });
}

// ═══════════════════════════════════════════════════════════
// SEND AUDIO REPLY (called from auto-reply.js after text reply)
// ═══════════════════════════════════════════════════════════
async function sendAudioReply(chatJid, text) {
  if (!audioConfig.respondWithAudio) return false;
  if (!sockRef) { console.error('[AudioTTS] No socket available'); return false; }

  if (!checkAndIncrementAudioCount(chatJid)) return false;

  const geminiKey = audioConfig.geminiApiKey
    || process.env.GEMINI_API_KEY
    || process.env.GEMINI_KEY
    || '';

  if (!geminiKey) {
    console.warn('[AudioTTS] No Gemini API key — skipping audio reply');
    const entry = audioCountMap.get(chatJid);
    if (entry && entry.count > 0) entry.count--;
    return false;
  }

  try {
    console.log(`[AudioTTS] Generating TTS for ${chatJid.split('@')[0]} — voice: ${audioConfig.voice}`);
    const { buffer: rawBuffer, mimeType } = await callGeminiTTS(text, audioConfig.voice, geminiKey);

    let audioBuffer = await audioToOgg(rawBuffer, mimeType);
    let audioMime = 'audio/ogg; codecs=opus';

    if (!audioBuffer) {
      // Fallback: send raw buffer (plays as audio file, not voice note icon)
      audioBuffer = rawBuffer;
      audioMime = mimeType || 'audio/wav';
      console.log('[AudioTTS] Sending as WAV fallback');
    }

    const isOgg = audioMime.includes('ogg');
    const waveform = generateWaveform(audioBuffer);
    const seconds = estimateDuration(audioBuffer, isOgg);

    await sockRef.sendMessage(chatJid, {
      audio: audioBuffer,
      mimetype: audioMime,
      ptt: true,
      waveform: waveform,
      seconds: seconds,
    });

    console.log(`[AudioTTS] ✅ Audio sent to ${chatJid.split('@')[0]} (${audioBuffer.length} bytes, ${seconds}s, waveform OK)`);
    return true;
  } catch (err) {
    console.error('[AudioTTS] Failed to send audio reply:', err.message);
    const entry = audioCountMap.get(chatJid);
    if (entry && entry.count > 0) entry.count--;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// AUDIO TEST
// ═══════════════════════════════════════════════════════════
async function sendAudioTest(chatJid, text) {
  if (!sockRef) throw new Error('No WhatsApp socket available');

  const geminiKey = audioConfig.geminiApiKey || process.env.GEMINI_API_KEY || '';
  if (!geminiKey) throw new Error('No Gemini API key configured in Supabase app_config');

  const testText = text || '¡Hola! Soy el asistente de Sánate. Esta es una prueba de voz con Gemini TTS. ¿Cómo estás?';
  const { buffer: rawBuffer, mimeType } = await callGeminiTTS(testText, audioConfig.voice, geminiKey);

  let audioBuffer = await audioToOgg(rawBuffer, mimeType);
  let audioMime = 'audio/ogg; codecs=opus';
  if (!audioBuffer) { audioBuffer = rawBuffer; audioMime = mimeType || 'audio/wav'; }

  const isOgg = audioMime.includes('ogg');
  const waveform = generateWaveform(audioBuffer);
  const seconds = estimateDuration(audioBuffer, isOgg);

  await sockRef.sendMessage(chatJid, { audio: audioBuffer, mimetype: audioMime, ptt: true, waveform, seconds });
  return { ok: true, bytes: audioBuffer.length, voice: audioConfig.voice, seconds };
}

// ═══════════════════════════════════════════════════════════
// VOICE PREVIEW (generate audio without sending via WhatsApp)
// ═══════════════════════════════════════════════════════════
async function generateVoicePreview(voiceName) {
  const geminiKey = audioConfig.geminiApiKey || process.env.GEMINI_API_KEY || '';
  if (!geminiKey) throw new Error('No Gemini API key configured');

  const previewText = '¡Hola! Soy tu asistente de Sánate.';
  const startMs = Date.now();
  const { buffer: rawBuffer, mimeType } = await callGeminiTTS(previewText, voiceName, geminiKey);
  const ttsMs = Date.now() - startMs;

  let audioBuffer = await audioToOgg(rawBuffer, mimeType);
  const convMs = Date.now() - startMs - ttsMs;
  let audioMime = 'audio/ogg; codecs=opus';
  if (!audioBuffer) { audioBuffer = rawBuffer; audioMime = mimeType || 'audio/wav'; }

  return {
    audio: audioBuffer.toString('base64'),
    mimeType: audioMime,
    bytes: audioBuffer.length,
    timing: { ttsMs, conversionMs: convMs, totalMs: Date.now() - startMs },
  };
}

module.exports = {
  initAudioTTS,
  updateAudioSocket,
  loadAudioSettings,
  saveAudioSettings,
  getAudioSettings,
  sendAudioReply,
  sendAudioTest,
  checkAndIncrementAudioCount,
  generateVoicePreview,
};
