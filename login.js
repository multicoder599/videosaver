require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

if (!API_ID || !API_HASH) {
  console.error('❌ Set API_ID and API_HASH in .env first');
  process.exit(1);
}

(async () => {
  console.log('🔐 Telegram login (userbot)\n');
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask('Phone number (with +254...): '),
    password: async () => await ask('2FA password (Enter if none): '),
    phoneCode: async () => await ask('Telegram OTP code: '),
    onError: (err) => console.log('Auth error:', err),
  });

  const session = client.session.save();
  console.log('\n✅ Login successful. Paste this line into your .env:\n');
  console.log(`SESSION_STRING=${session}\n`);

  await client.disconnect();
  rl.close();
})();