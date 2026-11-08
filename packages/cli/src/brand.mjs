const explore = 'https://remora-agents.pages.dev/explore';
const tagline = 'Ride the signal.';
const promise = 'Follow a leader using your own wallet.';

// The Remora SVG mark sampled into square pixels. Each terminal cell holds two pixels.
const pair = [
  '                                ',
  '             nn                 ',
  '             nbsn               ',
  '             nsbbn              ',
  '             sbsbbsn            ',
  ' sn         nbbbsbhbssssnn      ',
  ' sbn    nnssbbbhhhhhhhhhbbbsn   ',
  ' nbbn nsbbhhhhhhhhhbssssbbbhhsn ',
  '  sbssbhhhhhhhbbbbbsbhhbbbscbsn ',
  '  nbbbhhhhhbbsssbbbcbbcbbbbsn   ',
  '  sbnnnssbhbbbhhbbssssbhwwwwbn  ',
  ' nbs    nnssbhwhsnsssbwwhbsn    ',
  ' nsn        nnnnnssssssnn       ',
  ' nn     nn      nsdddttdd       ',
  ' n       dtddddddttttttdn       ',
  '         ddddddddddddn          ',
  '         n          n           ',
  '                                ',
];
const colors = {
  ' ': '5;16;32', n: '16;39;66', s: '69;102;140', b: '120;155;198', h: '167;191;221',
  w: '218;229;243', t: '43;224;199', c: '103;245;255', d: '8;123;131',
};
const reset = '\x1b[0m';
const bold = text => '\x1b[1m' + text + reset;

function pixelRow(top, bottom) {
  return '  ' + Array.from({ length: 32 }, (_, x) => {
    const upper = colors[top[x] ?? ' '];
    const lower = colors[bottom[x] ?? ' '];
    return upper === lower ? '\x1b[48;2;' + lower + 'm ' : '\x1b[38;2;' + upper + ';48;2;' + lower + 'm▀';
  }).join('') + reset;
}

export function renderHelp(version, help, { stream = process.stdout, env = process.env, plain = false } = {}) {
  const title = 'Remora CLI ' + version;
  const details = [title, tagline, promise, 'Explore agents  ' + explore];
  if (plain || !stream.isTTY || env.NO_COLOR || env.TERM === 'dumb') return details.join('\n') + '\n\n' + help;

  const width = stream.columns ?? 80;
  const sections = help.replace(/^([^\s\n][^\n]*):$/gm, (_, line) => bold(line));
  if (width < 78) return [bold(title), tagline, promise, details[3]].join('\n') + '\n\n' + sections;

  const header = [bold(title), '', bold(tagline), promise, '', 'Explore agents', explore];
  const rows = [];
  for (let y = 0; y < pair.length; y += 2) {
    rows.push(pixelRow(pair[y], pair[y + 1]) + (header[y / 2] ? '    ' + header[y / 2] : ''));
  }
  return rows.join('\n') + '\n\n' + sections;
}
