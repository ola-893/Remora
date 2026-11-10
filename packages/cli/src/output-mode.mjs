export const colorModes = ['auto', 'always', 'never'];

export function validateColor(color = 'auto') {
  if (!colorModes.includes(color)) throw new Error('INVALID_COLOR_MODE: use --color=auto|always|never.');
  return color;
}

export function usesColor({ stream, env = process.env, color = 'auto', json = false }) {
  validateColor(color);
  if (json || color === 'never') return false;
  if (color === 'always') return true;
  if (Object.hasOwn(env, 'NO_COLOR') || env.FORCE_COLOR === '0') return false;
  if (Object.hasOwn(env, 'FORCE_COLOR') && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY && env.TERM && env.TERM !== 'dumb');
}

export function colorFromArgs(args) {
  const equal = args.findLast(arg => arg.startsWith('--color='));
  const index = args.lastIndexOf('--color');
  const candidate = equal?.slice(8) ?? (index >= 0 ? args[index + 1] : 'auto');
  return colorModes.includes(candidate) ? candidate : 'auto';
}

// Restrained, readable hues. No colored backgrounds or dim secondary text.
export const tones = { info: '38;5;30', done: '38;5;71', wait: '38;5;172', error: '38;5;167' };
