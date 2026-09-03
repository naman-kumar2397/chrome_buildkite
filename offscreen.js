// Offscreen document: the only extension context that can play audio under
// Manifest V3. All chimes are synthesised with Web Audio, no files shipped.

let ctx = null;

function audio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Play one note with a click-free envelope. */
function tone(ac, master, { type = 'sine', freq, start, dur, peak = 1, detune = 0, filter }) {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (detune) osc.detune.setValueAtTime(detune, start);

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.setValueAtTime(peak, start + Math.max(0.012, dur * 0.35));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  let node = osc;
  if (filter) {
    const f = ac.createBiquadFilter();
    f.type = filter.type || 'lowpass';
    f.frequency.setValueAtTime(filter.freq, start);
    node.connect(f);
    node = f;
  }
  node.connect(gain).connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

const CHIMES = {
  // Rising major arpeggio: C5 E5 G5 C6
  success(ac, master, t) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      tone(ac, master, { type: 'sine', freq, start: t + i * 0.14, dur: 0.5, peak: 0.9 });
      tone(ac, master, { type: 'triangle', freq: freq * 2, start: t + i * 0.14, dur: 0.3, peak: 0.12 });
    });
    return 1.2;
  },
  // Two descending low buzzes: A3 -> F3, slightly detuned pair for grit
  failure(ac, master, t) {
    const steps = [[220, 0], [174.61, 0.42]];
    for (const [freq, offset] of steps) {
      tone(ac, master, { type: 'sawtooth', freq, start: t + offset, dur: 0.38, peak: 0.55, filter: { freq: 900 } });
      tone(ac, master, { type: 'sawtooth', freq, start: t + offset, dur: 0.38, peak: 0.35, detune: 14, filter: { freq: 900 } });
      tone(ac, master, { type: 'square', freq: freq / 2, start: t + offset, dur: 0.38, peak: 0.18, filter: { freq: 500 } });
    }
    return 1.0;
  },
  // Acknowledgement: two soft ascending blips, deliberately the quietest of
  // the four so auto-watching a build never competes with an outcome.
  watching(ac, master, t) {
    tone(ac, master, { type: 'sine', freq: 659.25, start: t, dur: 0.12, peak: 0.34 });
    tone(ac, master, { type: 'sine', freq: 987.77, start: t + 0.09, dur: 0.14, peak: 0.30 });
    return 0.3;
  },
  // Attention ping: two quick A5 pings, repeated once
  input(ac, master, t) {
    for (const base of [0, 0.62]) {
      for (const off of [0, 0.15]) {
        tone(ac, master, { type: 'triangle', freq: 880, start: t + base + off, dur: 0.16, peak: 0.9 });
        tone(ac, master, { type: 'sine', freq: 1760, start: t + base + off, dur: 0.12, peak: 0.25 });
      }
    }
    return 1.1;
  },
};

function play(kind, volume) {
  const ac = audio();
  const master = ac.createGain();
  master.gain.value = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.6));
  master.connect(ac.destination);
  const fn = CHIMES[kind] || CHIMES.input;
  return fn(ac, master, ac.currentTime + 0.02);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'PLAY') {
    try {
      const seconds = play(msg.kind, msg.volume);
      sendResponse({ ok: true, seconds });
    } catch (err) {
      sendResponse({ error: err?.message ?? String(err) });
    }
  }
  return false;
});
