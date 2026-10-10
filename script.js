/* ============================================================
   SonoBin — Sound to Binary Converter
   script.js  (vanilla JavaScript, no frameworks)

   Contents:
   1.  Utilities & element refs
   2.  Toast notifications
   3.  Navigation (mobile menu)
   4.  Scroll reveal (IntersectionObserver)
   5.  Binary "rain" background
   6.  Audio context / visualizer
   7.  Binary <-> sample conversion helpers
   8.  Tabs
   9.  Microphone (real-time) mode
   10. File upload mode (chunked processing)
   11. Tone generator mode
   12. Binary -> Sound (reverse) mode
   13. Output actions (copy / download / clear)
   14. Init
   ============================================================ */
'use strict';

/* ============================================================
   1. Utilities & element refs
   ============================================================ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioSupported = !!AudioCtx;

/* Limits that keep the page responsive with very large inputs */
const MAX_BITS      = 8_000_000;  // cap on stored binary ("Download full" respects this)
const PREVIEW_BITS  = 40_000;     // how much binary we render inside the textarea
const CHUNK_SAMPLES = 150_000;    // samples processed per animation frame

/* Element refs */
const els = {
  viz:        $('#viz'),
  vizWrap:    $('.visualizer'),
  output:     $('#output'),
  bitDepth:   $('#bitDepth'),
  sampleRate: $('#sampleRate'),
  channels:   $('#channels'),
  truncBadge: $('#truncBadge'),
  progress:   $('#progress'),
  progressBar:$('#progressBar'),
  toasts:     $('#toasts'),
  navToggle:  $('#navToggle'),
  navMobile:  $('#navMobile'),
  stats: {
    bits: document.querySelector('[data-stat="bits"]'),
    rate: document.querySelector('[data-stat="rate"]'),
    dur:  document.querySelector('[data-stat="dur"]'),
    size: document.querySelector('[data-stat="size"]'),
  },
};

/* Shared state */
const state = {
  ctx: null,               // AudioContext (lazy)
  analyser: null,          // active AnalyserNode (live visuals)
  activeSource: null,      // currently playing AudioBufferSourceNode
  micStream: null,         // MediaStream
  micInterval: null,       // real-time sampling interval
  recording: false,
  liveData: null,          // Uint8Array scratch for analyser frequency data
  staticWave: null,        // Float32Array drawn when not live (e.g. uploaded file)
  lastBinary: '',          // last produced binary (for download / reuse)
  lastTruncated: false,
  bitCount: 0,
  startedAt: 0,
};

/* Clamp helper */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* Format a byte count */
function formatBytes(bytes) {
  if (!isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/* Yield to the browser so the UI can paint (used by chunked loops) */
const nextFrame = () => new Promise((res) => requestAnimationFrame(() => res()));

/* ============================================================
   2. Toast notifications
   ============================================================ */
function showToast(title, message = '', type = 'success', timeout = 3600) {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__dot" aria-hidden="true"></span>
    <div class="toast__body">
      <strong></strong>
      ${message ? '<span></span>' : ''}
    </div>`;
  toast.querySelector('strong').textContent = title;
  if (message) toast.querySelector('span').textContent = message;
  els.toasts.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, timeout);
}

/* ============================================================
   3. Navigation (mobile menu)
   ============================================================ */
els.navToggle.addEventListener('click', () => {
  const open = els.navMobile.classList.toggle('is-open');
  els.navToggle.classList.toggle('is-open', open);
  els.navToggle.setAttribute('aria-expanded', String(open));
});
els.navMobile.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') {
    els.navMobile.classList.remove('is-open');
    els.navToggle.classList.remove('is-open');
    els.navToggle.setAttribute('aria-expanded', 'false');
  }
});

/* ============================================================
   4. Scroll reveal (IntersectionObserver)
   ============================================================ */
function initReveal() {
  const items = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
  items.forEach((el) => io.observe(el));
}

/* ============================================================
   5. Binary "rain" background
   ============================================================ */
function initBinaryRain() {
  const canvas = $('#binaryRain');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const fontSize = 16;
  let columns = 0, drops = [], dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = window.innerWidth  * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width  = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    columns = Math.ceil(window.innerWidth / fontSize);
    drops = new Array(columns).fill(0).map(() => Math.random() * -window.innerHeight);
  }
  resize();
  window.addEventListener('resize', resize);

  let last = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(ts) {
    // Throttle to ~18fps to stay light
    if (ts - last > 55) {
      last = ts;
      ctx.fillStyle = 'rgba(5, 8, 5, 0.18)';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.font = `${fontSize}px JetBrains Mono, monospace`;
      for (let i = 0; i < columns; i++) {
        const char = Math.random() > 0.5 ? '1' : '0';
        const x = i * fontSize;
        const y = drops[i];
        ctx.fillStyle = Math.random() > 0.94 ? 'rgba(198,245,107,0.9)' : 'rgba(25,195,125,0.55)';
        ctx.fillText(char, x, y);
        drops[i] = y > window.innerHeight && Math.random() > 0.975 ? 0 : y + fontSize;
      }
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  if (!reduce) requestAnimationFrame(frame);
}

/* ============================================================
   6. Audio context / visualizer
   ============================================================ */
function ensureCtx() {
  if (!audioSupported) {
    showToast('Audio not supported', 'Your browser lacks the Web Audio API.', 'error');
    return null;
  }
  if (!state.ctx) {
    state.ctx = new AudioCtx();
    state.liveData = new Uint8Array(state.ctx.frequencyBinCount);
  }
  if (state.ctx.state === 'suspended') state.ctx.resume();
  return state.ctx;
}

/* Canvas sizing (crisp on HiDPI) */
function fitCanvas() {
  const canvas = els.viz;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/* Continuous render loop for the visualizer */
function startVisualizer() {
  const canvas = els.viz;
  const ctx = canvas.getContext('2d');
  let size = fitCanvas();
  window.addEventListener('resize', () => { size = fitCanvas(); });

  function draw() {
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);

    let values;
    if (state.analyser) {
      const data = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(data);
      values = data;
    } else if (state.staticWave) {
      // Down-sample the stored waveform into ~64 buckets for a bar look
      const buckets = 64;
      values = new Uint8Array(buckets);
      const step = Math.max(1, Math.floor(state.staticWave.length / buckets));
      for (let i = 0; i < buckets; i++) {
        let peak = 0;
        for (let k = 0; k < step; k++) {
          const s = state.staticWave[i * step + k];
          if (s !== undefined) peak = Math.max(peak, Math.abs(s));
        }
        values[i] = Math.round(peak * 255);
      }
    } else {
      // Idle: gentle sine ripple
      values = new Uint8Array(64);
      const t = performance.now() / 600;
      for (let i = 0; i < 64; i++) values[i] = 12 + Math.sin(t + i * 0.3) * 6 + 6;
    }

    const bars = 64;
    const gap = 3;
    const barW = (w - gap * (bars - 1)) / bars;
    const count = values.length;

    for (let i = 0; i < bars; i++) {
      const v = values[Math.floor((i / bars) * count)] / 255;
      const barH = Math.max(3, v * (h - 24));
      const x = i * (barW + gap);
      const y = h - 12 - barH;

      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, 'rgba(198,245,107,1)');
      grad.addColorStop(1, 'rgba(25,195,125,0.25)');

      ctx.shadowColor = 'rgba(25,195,125,0.7)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = grad;
      const r = Math.min(barW / 2, 4);
      roundRect(ctx, x, y, barW, barH, r);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

/* Rounded rectangle path helper */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ============================================================
   7. Binary <-> sample conversion helpers
   ============================================================ */
const clampSample = (s) => clamp(s, -1, 1);

function quantize8(sample) {
  return clamp(Math.round((clampSample(sample) * 0.5 + 0.5) * 255), 0, 255);
}
function quantize16(sample) {
  return clamp(Math.round(clampSample(sample) * 32767), -32768, 32767);
}
function toBits8(v)  { return v.toString(2).padStart(8, '0'); }
function toBits16(v) { return (v & 0xffff).toString(2).padStart(16, '0'); }

function sampleToBits(sample, depth) {
  return depth === 8 ? toBits8(quantize8(sample)) : toBits16(quantize16(sample));
}
function bitsToSample(bits) {
  if (bits.length === 8) {
    return (parseInt(bits, 2) / 255) * 2 - 1;
  }
  let u = parseInt(bits, 2);
  if (u >= 32768) u -= 65536;
  return u / 32767;
}

/* Down-sample / up-sample a mono Float32Array to `targetRate` */
function resampleMono(mono, srcRate, targetRate) {
  if (srcRate === targetRate) return mono;
  const ratio = srcRate / targetRate;
  const outLen = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, mono.length - 1);
    const frac = pos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac; // linear interpolation
  }
  return out;
}

/* Average all channels of an AudioBuffer into one mono Float32Array */
function downmix(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  if (ch === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i];
  }
  for (let i = 0; i < len; i++) mono[i] /= ch;
  return mono;
}

/* ============================================================
   8. Tabs
   ============================================================ */
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => {
      t.classList.remove('is-active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('is-active');
    tab.setAttribute('aria-selected', 'true');
    const name = tab.dataset.tab;
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
    if (name !== 'mic' && state.recording) stopMic();
  });
});

/* ============================================================
   9. Microphone (real-time) mode
   ============================================================ */
const micBtn = $('#micBtn');
const micStatus = $('#micStatus');

micBtn.addEventListener('click', async () => {
  if (state.recording) { stopMic(); return; }
  await startMic();
});

async function startMic() {
  const ctx = ensureCtx();
  if (!ctx) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Microphone unavailable', 'getUserMedia is not supported here.', 'error');
    return;
  }
  if (!window.isSecureContext) {
    showToast('Insecure context', 'Microphone needs https:// or localhost.', 'error', 5200);
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.micStream = stream;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser); // NOT connected to destination (avoid feedback)
    state.analyser = analyser;

    state.recording = true;
    state.startedAt = performance.now();
    state.bitCount = 0;
    els.vizWrap.classList.add('is-live');
    micBtn.classList.add('is-recording');
    micStatus.textContent = 'Recording… tap to stop';
    showToast('Recording', 'Speak or play sound into your microphone.', 'info');

    const depth = parseInt(els.bitDepth.value, 10);
    const floatData = new Float32Array(analyser.fftSize);

    // Sample the time-domain data on a short interval and append binary.
    state.micInterval = setInterval(() => {
      analyser.getFloatTimeDomainData(floatData);
      let bits = '';
      // Use a subset each tick so output grows at a readable pace
      for (let i = 0; i < floatData.length; i += 4) {
        bits += sampleToBits(floatData[i], depth);
      }
      appendRealtimeBits(bits);
    }, 60);
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showToast(denied ? 'Microphone permission denied' : 'Microphone error',
              denied ? 'Allow mic access in your browser to record.' : (err.message || 'Unknown error'),
              'error');
    micStatus.textContent = 'Tap to record';
  }
}

function appendRealtimeBits(bits) {
  state.lastBinary += bits;
  state.bitCount += bits.length;
  if (state.lastBinary.length > MAX_BITS) {
    state.lastBinary = state.lastBinary.slice(0, MAX_BITS);
    state.lastTruncated = true;
  }
  // Live preview (keep the newest window visible)
  els.output.value = state.lastBinary.slice(-PREVIEW_BITS);
  els.output.scrollTop = els.output.scrollHeight;
  updateStats({
    bits: state.bitCount,
    rate: state.ctx ? state.ctx.sampleRate : 0,
    dur: (performance.now() - state.startedAt) / 1000,
    size: state.bitCount / 8,
  });
}

function stopMic() {
  if (state.micInterval) { clearInterval(state.micInterval); state.micInterval = null; }
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  state.analyser = null;
  state.recording = false;
  micBtn.classList.remove('is-recording');
  els.vizWrap.classList.remove('is-live');
  micStatus.textContent = 'Tap to record';
  finalizeOutput();
  showToast('Recording stopped', `${state.bitCount.toLocaleString()} bits captured.`, 'info');
}

/* ============================================================
   10. File upload mode (chunked processing)
   ============================================================ */
const fileInput = $('#fileInput');
const dropzone = $('#dropzone');

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-drag');
  }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
  }));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  const ctx = ensureCtx();
  if (!ctx) return;

  const okType = /\.(mp3|wav|ogg)$/i.test(file.name) || file.type.startsWith('audio/');
  if (!okType) {
    showToast('Unsupported file', 'Please choose an .mp3, .wav or .ogg file.', 'error');
    return;
  }

  resetOutput();
  showToast('Decoding', `Reading "${file.name}"…`, 'info');
  setProgress(0, true);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    await processAudioBuffer(audioBuffer, file.name);
  } catch (err) {
    console.error(err);
    setProgress(0, false);
    showToast('Could not decode file', 'The file may be corrupt or unsupported.', 'error');
  }
}

/* Turn a decoded AudioBuffer into binary, in chunks so the UI stays alive */
async function processAudioBuffer(buffer, label = '') {
  const ctx = ensureCtx();
  const targetRate = parseInt(els.sampleRate.value, 10);
  const depth = parseInt(els.bitDepth.value, 10);

  const mono = downmix(buffer);
  const resampled = resampleMono(mono, buffer.sampleRate, targetRate);

  // Static waveform for the visualizer (uploaded file preview)
  state.staticWave = resampled.length > 4096 ? resampled.slice(0, 100000) : resampled;
  state.analyser = null;
  els.vizWrap.classList.add('is-live');

  const parts = [];
  let totalBits = 0;
  let truncated = false;
  const total = resampled.length;

  for (let i = 0; i < total; i += CHUNK_SAMPLES) {
    const end = Math.min(i + CHUNK_SAMPLES, total);
    let chunk = '';
    for (let k = i; k < end; k++) chunk += sampleToBits(resampled[k], depth);
    parts.push(chunk);
    totalBits += chunk.length;

    setProgress(end / total, true);
    await nextFrame(); // let the browser breathe

    if (totalBits >= MAX_BITS) { truncated = true; break; }
  }

  setProgress(1, false);

  const full = parts.join('');
  state.lastBinary = full;
  state.lastTruncated = truncated;
  state.bitCount = totalBits;

  els.output.value =
    full.slice(0, PREVIEW_BITS) +
    (full.length > PREVIEW_BITS ? '\n…\n[ output truncated — use “Download .txt” for the full stream ]' : '');
  els.truncBadge.hidden = !truncated;

  updateStats({
    bits: totalBits,
    rate: targetRate,
    dur: buffer.duration,
    size: totalBits / 8,
  });

  showToast('Converted',
    `${label || 'Audio'} → ${totalBits.toLocaleString()} bits${truncated ? ' (capped)' : ''}.`,
    'success');
}

/* Generate a synthetic demo sample (no network needed) */
$('#loadDemoBtn').addEventListener('click', async () => {
  const ctx = ensureCtx();
  if (!ctx) return;
  const rate = ctx.sampleRate;
  const dur = 2;
  const samples = new Float32Array(rate * dur);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 4) * Math.exp(-1.2 * t); // quick attack, decay
    samples[i] =
      env * (0.5 * Math.sin(2 * Math.PI * 220 * t) +
             0.3 * Math.sin(2 * Math.PI * 330 * t) +
             0.2 * Math.sin(2 * Math.PI * 440 * t));
  }
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  showToast('Demo loaded', 'Converting a synthetic tone…', 'info');
  await processAudioBuffer(buffer, 'Demo tone');
});

/* ============================================================
   11. Tone generator mode
   ============================================================ */
$('#toneBtn').addEventListener('click', async () => {
  const ctx = ensureCtx();
  if (!ctx) return;

  const freq = clamp(parseFloat($('#toneFreq').value) || 440, 20, 20000);
  const dur  = clamp(parseFloat($('#toneDur').value) || 2, 0.1, 20);
  const wave = $('#toneWave').value;

  const rate = ctx.sampleRate;
  const samples = new Float32Array(Math.floor(rate * dur));
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const phase = (freq * t) % 1;
    let s;
    switch (wave) {
      case 'square':   s = phase < 0.5 ? 1 : -1; break;
      case 'sawtooth': s = 2 * phase - 1; break;
      case 'triangle': s = 4 * Math.abs(phase - 0.5) - 1; break;
      default:         s = Math.sin(2 * Math.PI * freq * t);
    }
    const env = Math.min(1, t * 8) * Math.min(1, (dur - t) * 8); // fade in/out
    samples[i] = s * env * 0.8;
  }

  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);

  // Play it (with visuals) and convert it to binary
  playBuffer(buffer, { loop: false });
  await processAudioBuffer(buffer, `${freq} Hz ${wave}`);
});

/* ============================================================
   12. Binary -> Sound (reverse) mode
   ============================================================ */
$('#decodeBtn').addEventListener('click', () => decodeAndPlay($('#binInput').value));

$('#loadOutputBtn').addEventListener('click', () => {
  if (!state.lastBinary) { showToast('Nothing yet', 'Convert some sound first.', 'error'); return; }
  $('#binInput').value = state.lastBinary.slice(0, PREVIEW_BITS);
  showToast('Loaded', 'Last output copied into the input.', 'info');
});

function decodeAndPlay(text) {
  const ctx = ensureCtx();
  if (!ctx) return;

  const clean = (text || '').replace(/[^01]/g, '');
  if (!clean.length) {
    showToast('No binary found', 'Paste a string of 0s and 1s.', 'error');
    return;
  }

  const depth = parseInt(els.bitDepth.value, 10);
  const targetRate = parseInt(els.sampleRate.value, 10);
  const count = Math.floor(clean.length / depth);
  if (count < 2) {
    showToast('Not enough data', `Need at least ${depth * 2} bits at this depth.`, 'error');
    return;
  }

  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = bitsToSample(clean.substr(i * depth, depth));
  }

  const buffer = ctx.createBuffer(1, count, targetRate);
  buffer.copyToChannel(samples, 0);
  playBuffer(buffer, { loop: false });
  showToast('Playing', `Decoded ${count.toLocaleString()} samples at ${depth}-bit.`, 'success');
}

/* ============================================================
   Playback helper (used by tone + reverse modes)
   ============================================================ */
function playBuffer(buffer, { loop = false } = {}) {
  const ctx = ensureCtx();
  if (state.activeSource) {
    try { state.activeSource.stop(); } catch (_) { /* already stopped */ }
    state.activeSource = null;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = loop;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;

  source.connect(analyser);
  analyser.connect(ctx.destination);

  state.analyser = analyser;
  state.staticWave = null;
  els.vizWrap.classList.add('is-live');

  source.onended = () => {
    if (state.activeSource === source) {
      state.activeSource = null;
      // keep the last frame; drop back to idle after a beat
      setTimeout(() => {
        if (!state.activeSource && !state.recording) {
          state.analyser = null;
          els.vizWrap.classList.remove('is-live');
        }
      }, 400);
    }
  };

  source.start();
  state.activeSource = source;

  updateStats({
    bits: state.bitCount,
    rate: buffer.sampleRate,
    dur: buffer.duration,
    size: state.bitCount / 8,
  });
}

/* ============================================================
   13. Output actions (copy / download / clear)
   ============================================================ */
$('#copyBtn').addEventListener('click', async () => {
  if (!els.output.value) { showToast('Nothing to copy', 'Generate some binary first.', 'error'); return; }
  try {
    await navigator.clipboard.writeText(els.output.value);
    showToast('Copied', 'Binary copied to clipboard.', 'success');
  } catch (_) {
    els.output.select();
    document.execCommand('copy');
    showToast('Copied', 'Binary copied to clipboard.', 'success');
  }
});

$('#downloadBtn').addEventListener('click', () => {
  const data = state.lastBinary || els.output.value;
  if (!data) { showToast('Nothing to download', 'Generate some binary first.', 'error'); return; }
  const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sonobin-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Downloaded', state.lastTruncated ? 'Saved (capped at the size limit).' : 'Saved full binary as .txt', 'success');
});

$('#clearBtn').addEventListener('click', () => {
  resetOutput();
  showToast('Cleared', 'Output box emptied.', 'info');
});

function resetOutput() {
  els.output.value = '';
  els.truncBadge.hidden = true;
  state.lastBinary = '';
  state.lastTruncated = false;
  state.bitCount = 0;
  state.staticWave = null;
  updateStats({ bits: 0, rate: '—', dur: '—', size: '—' });
  setProgress(0, false);
}

function finalizeOutput() {
  if (state.lastBinary.length > PREVIEW_BITS) {
    els.output.value = state.lastBinary.slice(-PREVIEW_BITS) + '\n…\n[ preview — Download .txt for full stream ]';
    els.truncBadge.hidden = false;
  } else {
    els.output.value = state.lastBinary;
  }
}

/* ============================================================
   Stats + progress helpers
   ============================================================ */
function updateStats({ bits, rate, dur, size }) {
  const s = els.stats;
  s.bits.textContent = typeof bits === 'number' ? bits.toLocaleString() : bits;
  s.rate.textContent = typeof rate === 'number' ? `${rate.toLocaleString()} Hz` : rate;
  s.dur.textContent  = typeof dur === 'number' ? `${dur.toFixed(2)} s` : dur;
  s.size.textContent = typeof size === 'number' ? formatBytes(size) : size;
}

function setProgress(ratio, visible) {
  els.progress.hidden = !visible;
  els.progressBar.style.width = `${clamp(ratio, 0, 1) * 100}%`;
  if (!visible) els.progressBar.style.width = '0%';
}

/* ============================================================
   14. Init
   ============================================================ */
function init() {
  initReveal();
  initBinaryRain();
  startVisualizer();

  // Copyright year
  const yearEl = $('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // The visualizer canvas is created before the reveal animation changes
  // its layout; re-fit once everything has settled.
  window.addEventListener('load', fitCanvas);
  setTimeout(fitCanvas, 400);

  if (!audioSupported) {
    showToast('Limited browser', 'The Web Audio API is unavailable; conversion may not work.', 'error', 6000);
  }

  // Unlock audio on first user interaction (mobile autoplay policies)
  const unlock = () => { ensureCtx(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock, { once: true });
}

document.addEventListener('DOMContentLoaded', init);
