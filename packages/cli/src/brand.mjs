import { wrap } from './presentation.mjs';

export function renderHelp(version, help, { stream = process.stdout, env = process.env, plain = false } = {}) {
  const title = 'Remora CLI ' + version;
  const color = !plain && stream.isTTY && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
  const heading = value => color ? `\x1b[36;1m${value}\x1b[0m` : value;
  const width = Math.max(20, Math.min(stream.columns ?? 80, 96));
  const intro = [heading(title), 'Ride the signal.', '', ...wrap('Useful work by one agent can benefit other agents. Streaming makes that exchange payable; guardrails let each follower use it on its own terms.', width), '', 'Explore agents  https://remora-agents.pages.dev/explore'];
  const body = stream.isTTY && !plain ? help.split('\n').flatMap(line => {
    if (line.length <= width) return [line];
    return wrap(line, width - 2).map(s => '  ' + s);
  }).join('\n') : help;
  return intro.join('\n') + '\n\n' + body.replace(/^([^\s\n][^\n]*):$/gm, (_, value) => heading(value + ':'));
}
