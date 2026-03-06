const BLUE = '\x1b[0;34m';
const ORANGE = '\x1b[0;33m';
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

export const logger = {
  info: (msg: string) => console.info(`${BLUE} ${msg}${NC}`),
  warn: (msg: string) => console.warn(`${ORANGE}[❗️] ${msg}${NC}`),
  error: (msg: string) => console.error(`${RED} ❌ Error:${NC} \x1b[33m${msg}\x1b[0m`),
  success: (msg: string) => console.info(`${GREEN} ✅ ${msg}${NC}`),
  header: (msg: string) => console.info(`${BLUE}${BOLD}${msg}${NC}`),
  dim: (msg: string) => console.info(`\x1b[2m ${msg}${NC}`),
};
