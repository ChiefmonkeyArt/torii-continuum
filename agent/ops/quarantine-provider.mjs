// Explicit operator action. Preserves encrypted claims and all other settings.
import { quarantineProvider } from './set-payment-mode.mjs';
if (process.argv.length !== 3) process.exit(1);
try { console.log(JSON.stringify(await quarantineProvider(process.argv[2]))); }
catch { console.error('Provider isolation failed; no configuration values printed.'); process.exit(1); }
