export function playPassFeedback() {
  navigator.vibrate?.(200);
  _playTone(880, 0.3, 'sine');
}

export function playFailFeedback() {
  navigator.vibrate?.([400, 200, 400, 200, 400]);
  _playTone(220, 1.5, 'sawtooth');
}

let _ctx = null;

function _playTone(freq, duration, type) {
  try {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _ctx.resume().then(() => {
      const osc = _ctx.createOscillator();
      const gain = _ctx.createGain();
      osc.connect(gain);
      gain.connect(_ctx.destination);
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.8, _ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, _ctx.currentTime + duration);
      osc.start();
      osc.stop(_ctx.currentTime + duration);
    });
  } catch (_) {}
}
