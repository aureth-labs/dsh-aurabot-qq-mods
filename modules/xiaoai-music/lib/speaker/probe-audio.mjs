// Synthetic audio: one opening beep, soft ticks, three louder ending beeps.
export function makeProbeAudio() {
  const rate = 16000;
  const seconds = 18;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  const beeps = [[0.2, 0.6], [15, 15.3], [16, 16.3], [17, 17.3]];
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const range = beeps.find(([start, end]) => t >= start && t < end);
    const tick = t >= 1 && t < 15 && t % 1 < 0.08;
    if (!range && !tick) continue;
    const start = range ? range[0] : Math.floor(t);
    const end = range ? range[1] : start + 0.08;
    const edge = Math.min(1, (t - start) * 100, (end - t) * 100);
    wav.writeInt16LE(Math.round(Math.sin(t * 2 * Math.PI * 660) * (range ? 2500 : 1000) * edge), 44 + i * 2);
  }
  return wav;
}
