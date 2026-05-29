require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const http = require('http'); // Added for the curl admin server

/* ==================== CONFIG ==================== */
const CONFIG = {
  apiId: parseInt(process.env.API_ID),
  apiHash: process.env.API_HASH,
  sessionString: process.env.SESSION_STRING || '',
  targetChannel: process.env.TARGET_CHANNEL,
  watermarkText: process.env.WATERMARK_TEXT || 'Watermark',
  watermarkFontPath: process.env.WATERMARK_FONT_PATH || '',
  sourceChannels: process.env.SOURCE_CHANNELS
    ? process.env.SOURCE_CHANNELS.split(',').map((s) => s.trim().replace('@', '').toLowerCase())
    : [],
  dirs: {
    downloads: path.join(__dirname, 'downloads'),
    temp: path.join(__dirname, 'temp'),
  },
};

/* ==================== UTILS ==================== */
async function ensureDirs() {
  for (const dir of Object.values(CONFIG.dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function checkFfmpeg() {
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      proc.on('close', (code) => (code === 0 ? resolve() : reject()));
      proc.on('error', reject);
    });
    console.log('✅ FFmpeg detected');
  } catch {
    console.error('❌ FFmpeg not found. Install it:');
    console.error('   Windows: winget install Gyan.FFmpeg');
    console.error('   Ubuntu:  sudo apt update && sudo apt install ffmpeg -y');
    process.exit(1);
  }
}

async function getFontPath() {
  if (CONFIG.watermarkFontPath) {
    try {
      await fs.access(CONFIG.watermarkFontPath);
      return CONFIG.watermarkFontPath;
    } catch {
      console.warn(`⚠️ Font not found at ${CONFIG.watermarkFontPath}, trying defaults...`);
    }
  }

  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Windows/Fonts/arial.ttf',
          'C:/Windows/Fonts/segoeui.ttf',
          'C:/Windows/Fonts/calibri.ttf',
        ]
      : [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
          '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
          '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        ];

  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {}
  }

  throw new Error(
    'No suitable font found for watermarking.\n' +
    'Windows: use a .ttf in C:/Windows/Fonts/\n' +
    'Ubuntu:  sudo apt install fonts-dejavu-core\n' +
    'Or set WATERMARK_FONT_PATH in .env'
  );
}

/* ==================== WATERMARK ==================== */
async function addWatermark(inputPath, outputPath) {
  const originalFont = await getFontPath();
  const tempFont = path.join(CONFIG.dirs.temp, 'watermark_font.ttf');
  await fs.copyFile(originalFont, tempFont);

  const text = CONFIG.watermarkText;

  const safeText = text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');

  const safeFontPath = path.relative(process.cwd(), tempFont).replace(/\\/g, '/');

  const filter =
    `drawtext=text='${safeText}':` +
    `fontfile='${safeFontPath}':` +
    `fontsize=24:` +
    `fontcolor=white:` +
    `borderw=2:` +
    `bordercolor=black:` +
    `x=(w-tw)/2:` +
    `y=(h-th)/2`;
    
  const args = [
    '-i', inputPath,
    '-vf', filter,
    '-c:a', 'copy',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}\n${stderr}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/* ==================== QUEUE ==================== */
const queue = [];
let busy = false;

async function runQueue(client) {
  if (busy || queue.length === 0) return;
  busy = true;
  
  const queueSize = queue.length;
  if (queueSize > 0) {
      console.log(`\n⏳ [Queue status: ${queueSize} video(s) waiting in line]`);
  }

  const { message } = queue.shift();
  try {
    await processVideo(client, message);
  } catch (err) {
    console.error('❌ Job failed:', err.message);
  }
  
  busy = false;
  runQueue(client);
}

/* ==================== VIDEO HANDLER ==================== */
async function processVideo(client, message) {
  const chat = await client.getEntity(message.peerId);
  const chatTitle = chat.title || 'Channel/Group';
  const chatUser = chat.username ? `@${chat.username}` : '';

  console.log(`\n🎬 Video from: ${chatTitle} ${chatUser}`);

  const ts = Date.now();
  const msgId = message.id;
  const ext = message.video ? '.mp4' : path.extname(message.document?.fileName || '.mp4');
  const safeExt = ext.match(/^\.\w+$/) ? ext : '.mp4';
  const base = `vid_${msgId}_${ts}`;

  const origPath = path.join(CONFIG.dirs.downloads, `${base}_orig${safeExt}`);
  const wmPath = path.join(CONFIG.dirs.temp, `${base}_wm${safeExt}`);

  try {
    console.log('⬇️  Downloading...');
    const buffer = await client.downloadMedia(message.media, {
      progressCallback: (got, total) => {
        if (total) process.stdout.write(`\r   ${((got / total) * 100).toFixed(0)}%`);
      },
    });
    await fs.writeFile(origPath, buffer);
    console.log('\n   Downloaded');

    console.log(`🎨 Watermarking with "${CONFIG.watermarkText}"...`);
    await addWatermark(origPath, wmPath);
    console.log('   Done');

    console.log('📤 Sending to target...');
    const caption = message.text || message.caption || `📹 ${chatTitle}`;
    await client.sendFile(CONFIG.targetChannel, {
      file: wmPath,
      caption,
      forceDocument: false,
    });
    console.log('   Sent successfully!');

  } finally {
    console.log('🧹 Sweeping up temporary files to save space...');
    await fs.unlink(origPath).catch(() => {});
    await fs.unlink(wmPath).catch(() => {});
  }
}
/* ==================== MAIN ==================== */
(async () => {
  await ensureDirs();
  await checkFfmpeg();

  if (!CONFIG.apiId || !CONFIG.apiHash) {
    console.error('❌ API_ID and API_HASH required');
    process.exit(1);
  }
  if (!CONFIG.sessionString) {
    console.error('❌ SESSION_STRING missing. Run: npm run login');
    process.exit(1);
  }
  if (!CONFIG.targetChannel) {
    console.error('❌ TARGET_CHANNEL missing');
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(CONFIG.sessionString),
    CONFIG.apiId,
    CONFIG.apiHash,
    { connectionRetries: 5 }
  );

  await client.start({ phoneNumber: async () => {} });
  console.log('🔐 Userbot connected');
  
  console.log('📚 Fetching dialogs to cache channel entities (This may take 5-10 seconds)...');
  await client.getDialogs({}); 
  
  console.log(`🎯 Target: ${CONFIG.targetChannel}`);
  console.log(`📝 Watermark: "${CONFIG.watermarkText}"`);
  console.log(`📋 Sources: ${CONFIG.sourceChannels.length ? CONFIG.sourceChannels.join(', ') : 'ALL joined channels and groups'}`);
  console.log('📡 Listening for videos...\n'); // Updated log message

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;

    // 🛑 This safely ignores your own uploads, so we don't need {incoming: true} below
    if (msg.out) return; 

    const isVideo = !!msg.video || (msg.document && msg.document.mimeType?.startsWith('video/'));
    if (!isVideo) return;

    if (msg.peerId?.className !== 'PeerChannel' && msg.peerId?.className !== 'PeerChat') return;

    if (CONFIG.sourceChannels.length > 0) {
      try {
        const chat = await client.getEntity(msg.peerId);
        const uname = (chat.username || '').toLowerCase();
        const cid = chat.id?.toString() || '';
        const shortId = cid.replace(/^-100/, '');
        const shortChatId = cid.replace(/^-/, '');

        const match = CONFIG.sourceChannels.some(
          (s) => uname === s || cid === s || shortId === s || shortChatId === s
        );
        if (!match) return; 
      } catch {
        return;
      }
    }

    queue.push({ message: msg });
    runQueue(client); 
    
  // 🛑 FIX: Removed { incoming: true } so it can hear channel broadcasts again
  }, new NewMessage({})); 
})();

// ==================== ADMIN WEB SERVER ====================
const PORT = 3015;
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'Online and Listening',
      queueSize: queue.length,
      isProcessing: busy,
      listeningTo: CONFIG.sourceChannels.length > 0 
        ? CONFIG.sourceChannels 
        : 'ALL joined channels and groups (No .env filter applied)'
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Admin server running! Check status with: curl http://localhost:${PORT}/status`);
});