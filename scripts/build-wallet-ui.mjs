import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('packages/cli/wallet-ui',{recursive:true});
await build({entryPoints:['packages/cli/wallet-src/main.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:'packages/cli/wallet-ui/wallet.js',minify:true});
await copyFile('packages/cli/wallet-src/index.html','packages/cli/wallet-ui/index.html');
console.log('Owner wallet browser UI built.');
