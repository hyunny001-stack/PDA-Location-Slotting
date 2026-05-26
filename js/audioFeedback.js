export function playPassFeedback() {
  navigator.vibrate?.(200);
  _playTone(880, 0.3, 'sine');
}

export function playFailFeedback() {
  navigator.vibrate?.([400, 200, 400, 200, 400]);
  _playTone(220, 1.5, 'sawtooth');
}

function _playTone(freq, duration, type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.8, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}
